var Service, Characteristic;
var request = require('request');

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    
    homebridge.registerAccessory("homebridge-sonoff-tasmota-http", "SonoffTasmotaHTTP", SonoffTasmotaHTTPAccessory);
}

function SonoffTasmotaHTTPAccessory(log, config) {
    this.log = log;
    this.config = config;
    this.name = config["name"]
    this.relay = config["relay"] || ""
    this.hostname = config["hostname"] || "sonoff"
    this.password = config["password"] || "";
    this.cachedState = "OFF";
    
    this.service = new Service.Outlet(this.name);
    
    this.service
    .getCharacteristic(Characteristic.On)
    .on('get', this.getState.bind(this))
    .on('set', this.setState.bind(this));
    
    console.info("Sonoff Tasmota HTTP Initialized")
}

SonoffTasmotaHTTPAccessory.prototype.getState = function(callback) {
    switch (this.cachedState) {
        case "ON":
            callback(null, 1);
            break;
        case "OFF":
            callback(null, 0);
            break;
    }
    readState(this, 0);
}

SonoffTasmotaHTTPAccessory.prototype.setState = function(toggle, callback) {
    if (toggle) {
        this.cachedState = "ON";
    } else {
        this.cachedState = "OFF";
    }
    callback();
    writeState(this, toggle, 0);
}

SonoffTasmotaHTTPAccessory.prototype.getServices = function() {
    return [this.service];
}

function readState(that, retry) {
    console.info("Sonoff Tasmota HTTP Reading...");
    request("http://" + that.hostname + "/cm?user=admin&password=" + that.password + "&cmnd=Power" + that.relay, function(error, response, body) {
        // Don't give up on first attempt, try up to 3 times
        if (error) {
            if (retry < 3) {
                console.error("Sonoff Tasmota HTTP Error (retry: "+ retry +"): " + error);
                setTimeout(function() {
                    readState(retry + 1);
                }, retry * 1000);
            }
            return;
        }
        var sonoff_reply = JSON.parse(body); // {"POWER":"ON"}
        console.info("Sonoff HTTP: " + that.hostname + ", Relay " + that.relay + ", Get State: " + JSON.stringify(sonoff_reply));
        switch (sonoff_reply["POWER" + that.relay]) {
            case "ON":
                that.cachedState = "ON";
                that.service.updateCharacteristic(Characteristic.On, 1);
                break;
            case "OFF":
                that.cachedState = "OFF";
                that.service.updateCharacteristic(Characteristic.On, 0);
                break;
        }
    })
}

function writeState(that, state, retry) {
    var newstate = "%20Off"
    if (state) newstate = "%20On" 
        console.info("Sonoff Tasmota HTTP Writing...");
	request("http://" + that.hostname + "/cm?user=admin&password=" + that.password + "&cmnd=Power" + that.relay + newstate, function(error, response, body) {
		// Don't give up on first attempt, try up to 3 times
		if (error) {
			if (retry < 3) {
				console.error("Sonoff Tasmota HTTP Error (retry: "+ retry +"): " + error);
				setTimeout(function() {
					writeState(that, state, retry + 1);
				}, retry * 1000);
			}
			return;
		}
		var sonoff_reply = JSON.parse(body); // {"POWER":"ON"}
		console.info("Sonoff HTTP: " + that.hostname + ", Relay " + that.relay + ", Set State: " + JSON.stringify(sonoff_reply));
		switch (sonoff_reply["POWER" + that.relay]) {
			case "ON":
				that.cachedState = "ON";
				that.service.updateCharacteristic(Characteristic.On, 1);
				break;
			case "OFF":
				that.cachedState = "OFF";
				that.service.updateCharacteristic(Characteristic.On, 0);
				break;
		}
	})    
}
