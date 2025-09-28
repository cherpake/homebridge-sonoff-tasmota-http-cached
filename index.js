/* eslint-disable no-var */
'use strict';

var Service, Characteristic;
var request = require('request');

// ---------- Config defaults ----------
const DEFAULT_POLL_SECONDS = 60;         // how often to poll the device
const MIN_POLL_SECONDS = 5;              // safety lower bound
const REQUEST_TIMEOUT_MS = 5000;         // HTTP timeout
const RETRY_DELAY_MS = 500;              // delay between read retries
const MAX_READ_RETRIES = 3;              // read attempts total

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerAccessory(
    'homebridge-sonoff-tasmota-http',
    'SonoffTasmotaHTTP',
    SonoffTasmotaHTTPAccessory
  );
};

function SonoffTasmotaHTTPAccessory(log, config) {
  this.log = log;
  this.config = config || {};

  // Basic config
  this.name = this.config.name || 'Tasmota Switch';
  this.hostname = this.config.hostname || 'sonoff'; // host or IP
  this.relay = String(this.config.relay || '');     // "", "1", "2", ...

  // Optional auth for Tasmota web (leave blank if not used)
  this.username = this.config.username || this.config.user || '';
  this.password = this.config.password || '';

  // Polling
  var poll = Number(this.config.pollInterval || DEFAULT_POLL_SECONDS);
  if (isNaN(poll) || poll < MIN_POLL_SECONDS) poll = DEFAULT_POLL_SECONDS;
  this.pollIntervalSec = poll;
  this._pollHandle = null;

  // Cached state (boolean for HomeKit)
  this.cachedOn = false;

  // Services
  this.informationService = new Service.AccessoryInformation()
    .setCharacteristic(Characteristic.Manufacturer, 'Tasmota')
    .setCharacteristic(Characteristic.Model, 'HTTP Switch')
    .setCharacteristic(Characteristic.SerialNumber, this.hostname + (this.relay ? `#${this.relay}` : ''));

  this.service = new Service.Switch(this.name);
  this.service
    .getCharacteristic(Characteristic.On)
    .on('get', this.handleGetOn.bind(this))
    .on('set', this.handleSetOn.bind(this));
}

// ---------- Homebridge required methods ----------
SonoffTasmotaHTTPAccessory.prototype.getServices = function () {
  // Initial read so Home shows correct state asap
  this.readState(1);

  // Start periodic polling
  this.startPolling();

  // Ensure cleanup on exit
  this.installCleanupHandlers();

  return [this.informationService, this.service];
};

SonoffTasmotaHTTPAccessory.prototype.identify = function (callback) {
  this.log('Identify requested');
  callback();
};

// ---------- Polling ----------
SonoffTasmotaHTTPAccessory.prototype.startPolling = function () {
  if (this._pollHandle) return;

  this.log(`Starting polling every ${this.pollIntervalSec}s`);
  this._pollHandle = setInterval(() => {
    this.readState(1);
  }, this.pollIntervalSec * 1000);
};

SonoffTasmotaHTTPAccessory.prototype.stopPolling = function () {
  if (this._pollHandle) {
    clearInterval(this._pollHandle);
    this._pollHandle = null;
    this.log('Stopped polling');
  }
};

SonoffTasmotaHTTPAccessory.prototype.installCleanupHandlers = function () {
  if (this._cleanupInstalled) return;
  const cleanup = () => {
    try {
      this.stopPolling();
    } catch (e) {
      /* noop */
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('beforeExit', cleanup);
  this._cleanupInstalled = true;
};

// ---------- Characteristic handlers ----------
SonoffTasmotaHTTPAccessory.prototype.handleGetOn = function (callback) {
  // Use cached value while we refresh in background
  callback(null, this.cachedOn);
  // Kick a refresh (non-blocking)
  this.readState(1);
};

SonoffTasmotaHTTPAccessory.prototype.handleSetOn = function (value, callback) {
  // Optimistically cache to keep UI snappy
  this.cachedOn = !!value;
  this.service.updateCharacteristic(Characteristic.On, this.cachedOn);

  const desired = this.cachedOn ? 'ON' : 'OFF';
  this.sendPowerCommand(desired, (err) => {
    if (err) {
      this.log('Set failed, reverting cache:', err.message || err);
      // On error, re-read actual state to resync
      this.readState(1);
      return callback(err);
    }
    // Success — optionally read back to confirm
    this.readState(1);
    callback();
  });
};

// ---------- HTTP helpers ----------
SonoffTasmotaHTTPAccessory.prototype.baseUrl = function () {
  // e.g. http://192.168.1.50/cm
  return `http://${this.hostname}/cm`;
};

SonoffTasmotaHTTPAccessory.prototype.buildQuery = function (cmnd) {
  // cmnd examples: "Power", "Power1", "Power2", "Power ON", "Power1 OFF"
  const params = new URLSearchParams();
  if (this.username) params.append('user', this.username);
  if (this.password) params.append('password', this.password);
  params.append('cmnd', cmnd);
  return params.toString();
};

SonoffTasmotaHTTPAccessory.prototype.requestJson = function (url, callback) {
  request(
    {
      url,
      method: 'GET',
      timeout: REQUEST_TIMEOUT_MS,
      gzip: true
    },
    (error, response, body) => {
      if (error) return callback(error);
      if (!response || response.statusCode < 200 || response.statusCode >= 300) {
        return callback(new Error(`HTTP ${response ? response.statusCode : 'NO_RESPONSE'}`));
      }
      try {
        // Tasmota returns JSON like {"POWER":"ON"} or {"POWER1":"OFF"}
        const json = JSON.parse(body);
        callback(null, json);
      } catch (e) {
        // Some firmwares may return plain text ("ON"/"OFF"); wrap it
        const trimmed = String(body || '').trim();
        if (trimmed === 'ON' || trimmed === 'OFF') {
          callback(null, { POWER: trimmed });
        } else {
          callback(new Error('Unexpected response: ' + trimmed));
        }
      }
    }
  );
};

// ---------- Device ops ----------
SonoffTasmotaHTTPAccessory.prototype.readState = function (attempt) {
  attempt = attempt || 1;
  const powerKey = 'Power' + (this.relay || ''); // Power, Power1, Power2...
  const url = `${this.baseUrl()}?${this.buildQuery(powerKey)}`;

  this.log(`Reading state (attempt ${attempt}/${MAX_READ_RETRIES})`);
  this.requestJson(url, (err, json) => {
    if (err) {
      if (attempt < MAX_READ_RETRIES) {
        this.log(`Read error: ${err.message || err}; retrying...`);
        return setTimeout(() => this.readState(attempt + 1), RETRY_DELAY_MS);
      }
      this.log('Read failed: ' + (err.message || err));
      return;
    }

    // Extract "ON"/"OFF" from POWER or POWER{n}
    const keysToCheck = [];
    if (this.relay) keysToCheck.push(`POWER${this.relay}`);
    keysToCheck.push('POWER');

    let stateStr = null;
    for (var i = 0; i < keysToCheck.length; i++) {
      const k = keysToCheck[i];
      if (Object.prototype.hasOwnProperty.call(json, k)) {
        stateStr = String(json[k]).toUpperCase();
        break;
      }
    }

    if (stateStr !== 'ON' && stateStr !== 'OFF') {
      this.log('Unexpected JSON payload, cannot find POWER key:', JSON.stringify(json));
      return;
    }

    const newOn = stateStr === 'ON';
    if (newOn !== this.cachedOn) {
      this.log(`State updated: ${this.cachedOn ? 'ON' : 'OFF'} -> ${newOn ? 'ON' : 'OFF'}`);
      this.cachedOn = newOn;
      this.service.updateCharacteristic(Characteristic.On, this.cachedOn);
    }
  });
};

SonoffTasmotaHTTPAccessory.prototype.sendPowerCommand = function (desiredOnOff, callback) {
  const desired = String(desiredOnOff).toUpperCase(); // "ON" or "OFF"
  const powerKey = 'Power' + (this.relay || '');
  const url = `${this.baseUrl()}?${this.buildQuery(`${powerKey} ${desired}`)}`;

  this.log(`Sending command: ${powerKey} ${desired}`);
  this.requestJson(url, (err, json) => {
    if (err) return callback(err);

    // Validate acknowledgement
    const ackKey = this.relay ? `POWER${this.relay}` : 'POWER';
    const ackVal = json[ackKey];
    if (typeof ackVal === 'string' && ackVal.toUpperCase() === desired) {
      return callback(null);
    }

    // Some firmwares return {"POWER":"ON"} even when addressed by Power1
    if (typeof json.POWER === 'string' && json.POWER.toUpperCase() === desired) {
      return callback(null);
    }

    // Fallback: not clearly acknowledged, but no HTTP error — still succeed
    this.log('Command sent, response ambiguous:', JSON.stringify(json));
    callback(null);
  });
};

// ---------- End of file ----------
