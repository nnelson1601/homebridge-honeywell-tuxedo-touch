"use strict";
import got from "got";
import CryptoJS from "crypto-js";
import { parse } from "node-html-parser";
import pollingtoevent from "polling-to-event";
import { CookieJar } from "tough-cookie";
import { inspect } from "util";
 
let Service, Characteristic;

var protocol = "https";
var apibasepath = "/system_http_api/API_REV01";
var hPath = "API_REV01";

let CurrentState = 3;
let TargetState = 3;
let lastTargetState = 3;
let lastValidCurrentState = 3;

var alarmStatus = {
  "Armed Stay"        : 0,
  "Armed Stay Fault"  : 0,
  "Armed Away"        : 1,
  "Armed Away Fault"  : 1,
  "Armed Night"       : 2,
  "Armed Instant"     : 2,
  "Armed Instant Fault": 2, 
  "Armed Night Fault" : 2,
  "Ready Fault"       : 3,
  "Ready To Arm"      : 3,
  "Not Ready"         : 3,
  "Not Ready Fault"   : 3,
  "Entry Delay Active": 4,
  "Not Ready Alarm"   : 4,
  "Armed Stay Alarm"  : 4,
  "Armed Night Alarm" : 4,
  "Armed Away Alarm"  : 4,
  "Not available"     : 5, // At certain times, tuxedo API returns a Not available value with a successful API response, not sure why this is, set accessory to general fault when this happens
  "Error"             : 5, // Tuxedo api can be tempramental at times, when the API call fails, we set the accessory to general fault.
};

export default (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory(
    "homebridge-honeywell-tuxedo-touch",
    "Honeywell Tuxedo Touch",
    HoneywellTuxedoAccessory
  );
};

function HoneywellTuxedoAccessory(log, config) {
  this.log = log;
  this.config = config;
  this.debug = config.debug || false;
  this.fetchKeysBeforeEverySetCall = config.fetchKeysBeforeEverySetCall || false;
  this.polling = config.polling || false;
  this.pollInterval = config.pollInterval || 30000;

  // extract name from config
  this.name = config.name || "Honeywell Tuxedo Security";

  this.host = config.host;
  this.port = config.port || "";

  this.mac = config.mac;
  this.api_key_enc = config.private_key.substring(0, 64);
  this.api_iv_enc = config.private_key.substring(64, 96);

  if (!config.alarmCode) {
    this.log("Alarm code is missing from config");
  }
  this.uCode = config.alarmCode;

  (async () => {
    await getAPIKeys.call(this);
  })();

  // create a new Security System service
  this.SecuritySystem = new Service.SecuritySystem(this.name);

  // create handlers for required characteristics
  this.SecuritySystem.getCharacteristic(
    Characteristic.SecuritySystemCurrentState
  ).on("get", this.handleSecuritySystemCurrentStateGet.bind(this));

  this.SecuritySystem.getCharacteristic(
    Characteristic.SecuritySystemTargetState
  )
    .on("get", this.handleSecuritySystemTargetStateGet.bind(this))
    .on("set", this.handleSecuritySystemTargetStateSet.bind(this));

  if (this.debug) this.log("Service creation complete");
}

HoneywellTuxedoAccessory.prototype = {
  /**
   * Init method for regular polling of device state, fired after the api keys have been retrieved
   */
  init: function () {
    var self = this;

    // Set up continuous polling if configured
    if (self.debug) self.log("[init] Polling is set to : " + self.polling);
    if (self.polling) {
      self.log("Starting polling with an interval of %s ms", self.pollInterval);

      var emitterConfig = [
        {
          method: self.handleSecuritySystemCurrentStateGet.bind(this),
          property: "current state",
          characteristic: Characteristic.SecuritySystemCurrentState,
        },
        {
          method: self.handleSecuritySystemTargetStateGet.bind(this),
          property: "target state",
          characteristic: Characteristic.SecuritySystemTargetState,
        },
      ];

      emitterConfig.forEach((config) => {
        var emitter = pollingtoevent(
          function (done) {
            config.method(function (err, result) {
              done(err, result);
            });
          },
          { longpolling: true, interval: self.pollInterval }
        );

        emitter.on("longpoll", function (state) {
          if(state != 5){
              self.log(
              "Polling noticed %s change to %s, notifying devices",
              config.property,
              state
              );
            if (config.property === "target state") {
              if(state == 4){
                // Homekit doesn't accept a triggered value for target state, hence set the targetstate to last known target state
                if(self.debug) self.log("Received target state 4, setting target state to lastTargetState: " + self.lastTargetState);
                  self.SecuritySystem.getCharacteristic(config.characteristic).setValue(self.lastTargetState);
                }else{
                  self.lastTargetState = state;  
                  self.SecuritySystem.getCharacteristic(config.characteristic).setValue(state);
                }
            } else {
              self.SecuritySystem.getCharacteristic(config.characteristic).setValue(state);
            }
            // Set Statusfault characteristic to no fault
            self.SecuritySystem.getCharacteristic(Characteristic.StatusFault).setValue(0)
          } else {
            // When state is 5, an error has been encountered, most common causes are unit not reachable due to internet issues or returning state as not available
            // Set Statusfault characteristic to General Fault
            self.SecuritySystem.getCharacteristic(Characteristic.StatusFault).setValue(1)
            self.log("Security system state unavailable, setting state to fault")
          }
        }
          );

        emitter.on("error", function (err) {
          self.log("Polling of %s failed, error was %s", config.property, err);
          // Set Statusfault characteristic to General Fault
          this.SecuritySystem.getCharacteristic(Characteristic.StatusFault).setValue(1)
        });
      });
    }
    // Fetch API keys every 5 mins 
    // This is to work around a bug in many Tuxedo units which periodically starts returning the wrong status
    // until some page is fecthed in a browser, fetching keys again loads tuxedoapi.html which has the same affect
    function tuxedoApiStateHack() {
      if(this.debug) this.log("[tuxedoApiStateHack] Re-fetching API keys");
      (async () => {
        getAPIKeys.bind(this);
      })();
    }
    setInterval(tuxedoApiStateHack,300000);
  },
  getServices: function () {
    if (this.debug) this.log("Get Services called");
    if (!this.SecuritySystem) return [];

    const infoService = new Service.AccessoryInformation();
    infoService.setCharacteristic(
      Characteristic.Manufacturer,
      "Honeywell-Tuxedo"
    );

    return [infoService, this.SecuritySystem];
  },
  /**
   * Handle requests to get the current value of the "Security System Current State" characteristic
   */
  handleSecuritySystemCurrentStateGet: function (callback) {
    if (this.debug) this.log("[handleSecuritySystemCurrentStateGet] Triggered GET SecuritySystemCurrentState");

    getAlarmMode.apply(this, [returnCurrentState.bind(this)]);

    function returnCurrentState(value) {
      var statusString = JSON.parse(value).Status.toString().trim();
      if (this.debug)
        this.log(
          "[returnCurrentState] Retrieved status string: " +
            statusString +
            ", alarmStatus is: " +
            alarmStatus[statusString]
        );
      CurrentState =
        alarmStatus[statusString] === undefined ? 3 : alarmStatus[statusString];
      
        // If we find a state that isn't defined in alarm status and it isn't a arming / delay state, report in the log
        if ((alarmStatus[statusString] === undefined) && (statusString.indexOf("Secs Remaining") == -1)) {
          this.log(
            "[handleSecuritySystemCurrentStateGet] Unknown alarm state: " +
              statusString +
              " please report this through a github issue to the developer"
          );
        }

      if (this.debug)
        this.log(
          "[returnCurrentState] Received value: " +
            value +
            ", corresponding current state: " +
            CurrentState
        );
      if (CurrentState != 5){
        this.lastValidCurrentState = CurrentState;
      }else{
        CurrentState = this.lastValidCurrentState;
        if(this.debug) this.log("[handleSecuritySystemCurrentStateGet] Current state was Not available / error, returning the last known good state: " + this.lastValidCurrentState);
      }
      callback(null, CurrentState);
    }
  },

  /**
   * Handle requests to get the current value of the "Security System Target State" characteristic
   */
  handleSecuritySystemTargetStateGet: function (callback) {
    if (this.debug) this.log("Triggered GET SecuritySystemTargetState");

    getAlarmMode.apply(this, [returnTargetState.bind(this)]);

    function returnTargetState(value) {
      var statusString = JSON.parse(value).Status.toString().trim();

      if (statusString.indexOf("Secs Remaining") != -1) {
        TargetState = this.lastTargetState;
      } else {
        TargetState =
          alarmStatus[statusString] === undefined
            ? 3
            : alarmStatus[statusString];
        // Homekit doesn't accept a targetState of 4 (triggered), when triggered, return lastTargetState
        if((TargetState == 4) || (TargetState == 5)) TargetState = this.lastTargetState;
        if(this.debug) this.log("[handleSecuritySystemTargetStateGet] Target state was: " + TargetState + " returning lastTargetState: " + this.lastTargetState); 
      }

      if (
        (alarmStatus[statusString] === undefined) && 
        (statusString.indexOf("Secs Remaining") == -1)
      ) {
        this.log(
          "[handleSecuritySystemTargetStateGet] Unknown alarm state: " +
            statusString +
            " please report this through a github issue to the developer"
        );
      }

      if (this.debug)
        this.log(
          "[returnTargetState] Received value: " +
            value +
            ", corresponding target state: " +
            TargetState
        );

      callback(null, TargetState);
    }
  },

  /**
   * Handle requests to set the "Security System Target State" characteristic
   */
  handleSecuritySystemTargetStateSet: function (value, callback) {
    if (this.debug)
      this.log("[handleSecuritySystemTargetStateGet] Triggered SET SecuritySystemTargetState:" + value);

    if (this.fetchKeysBeforeEverySetCall){
      if(this.debug) this.log("[handleSecuritySystemCurrentStateGet] fetchKeysBeforeEverySetCall config is true, fetching API keys again");
      (async () => {
        await getAPIKeys.bind(this);
      })();
    }

    TargetState = value;
    //Capture the last target state if it isn't disarmed
    if(value != 3)
    	this.lastTargetState = value;
    if (value == 0) armAlarm.apply(this, ["STAY", callback]);
    if (value == 1) armAlarm.apply(this, ["AWAY", callback]);
    if (value == 2) armAlarm.apply(this, ["NIGHT", callback]);
    if (value == 3) disarmAlarm.apply(this, [callback]);
  },
};

async function callAPI_POST(url, data, paramlength, headers, callback) {
  const gotCookieJar = new CookieJar();
  //const setCookie = promisify(cookieJar.setCookie.bind(cookieJar));

  const options = {
    method: "POST",
    url: url,
    headers: {
      authtoken: headers,
      identity: this.api_iv_enc,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "param=" + data + "&len=" + paramlength + "&tstamp=" + Math.random(),
    cookieJar: gotCookieJar,
    https: {
      rejectUnauthorized: false,
    },
  };
  if (this.debug)
    this.log(
      "[callAPI_POST]: Calling alarm API with url: " +
        options.url +
        " headers - authtoken: " +
        options.headers["authtoken"] +
        " headers-identity" +
        options.headers["identity"] +
        " body: " +
        options.body
    );

  try {
    var response = await got.post(options);
    var respFinal;
    var respJSON = JSON.parse(response.body);
    try {
      respFinal = respJSON["Result"];
    } catch (e) {
      try {
        respFinal = respJSON.Result;
      } catch (e) {
        respFinal = respJSON.toString();
      }
    }
    // At this point, we have the result, so any callbacks can be executed
    if (this.debug) this.log("[callAPI_POST] Trying to decrypt response: " + respFinal);
    var decryptedData = decryptData.apply(this, [respFinal]);
    //if (this.debug) this.log("[callAPI_POST] Response final decrypted: " + decryptedData);


    var statusString = JSON.parse(decryptedData).Status.toString().trim();
    /* Tuxedo has an annoying bug, sometimes the unit disconnects from the router and upon reconnecting, the GET API call continuously returns a "Not available" status.
     * This seems to fix itself when the homepage tuxedoapi.html is loaded on any browser
     * hence as a hack, if we receive a Not available state, we will try to fetch api keys again which loads the tuxedoapi.html programmatically to resolve the issue
     */
    if(statusString == "Not available") {
        this.log("[callAPI_POST] Received response 'Not available', applying tuxedo bug workaround, fetching api keys again, if successful this should resolve the problem in the next call");
        (async () => {
          await getAPIKeys.call(this);
        })();
    }
    // return data 
    callback(decryptedData);
    
  } catch (error) {
    if (this.debug) {
      this.log("[callAPI_POST] Error:", error);
    } else {
      this.log("[callAPI_POST] Error:" + error.message);
      callback('{"Status":"Error"}'); //Return an error state, this is mapped to an invalid state 5 in the alarmStatus dict
    }
  }
}

function getAlarmMode(callback) {
  var url = protocol + "://" + this.host;
  if (this.port != "") url += ":" + this.port;
  url += apibasepath + "/GetSecurityStatus";
  var header = "MACID:" + this.mac + ",Path:" + hPath + "/GetSecurityStatus";
  var data = encryptData.apply(this, [
    "mac=" +
      this.mac +
      "&operation=get",
  ]);
  if (this.debug)
    this.log(
      "[getAlarmMode] About to call with, url: " +
        url +
        " header: " +
        header +
        " body: " +
        data
    );
  callAPI_POST.apply(this, [
    url,
    data,
    data.length,
    CryptoJS.HmacSHA1(header, this.api_key_enc),
    callback,
  ]);
}

function armAlarm(mode, callback) {
  var pID = 1;
  var dataCnt = encryptData.apply(this, [
    "arming=" +
      mode +
      "&pID=" +
      pID +
      "&ucode=" +
      parseInt(this.uCode) +
      "&operation=set",
  ]);
  var url = protocol + "://" + this.host;
  if (this.port != "") url += ":" + this.port;
  url += apibasepath + "/AdvancedSecurity/ArmWithCode"; //?param=" + encryptData(dataCnt);

  var header = "MACID:" + this.mac + ",Path:" + hPath + "/AdvancedSecurity/ArmWithCode";
  if (this.debug)
    this.log(
      "[armAlarm] About to call API with, url:" +
        url +
        " dataCnt: " +
        dataCnt +
        " header: " +
        header +
        " api_key_enc: " +
        this.api_key_enc
    );
  callAPI_POST.apply(this, [
    url,
    dataCnt,
    dataCnt.length,
    CryptoJS.HmacSHA1(header, this.api_key_enc),
    finishArming,
  ]);

  function finishArming() {
    callback(null);
  }
}

function disarmAlarm(callback) {
  var pID = 1;
  var dataCnt = encryptData.apply(this, [
    "pID=" + pID + "&ucode=" + parseInt(this.uCode) + "&operation=set",
  ]);
  var url = protocol + "://" + this.host;
  if (this.port != "") url += ":" + this.port;
  url += apibasepath + "/AdvancedSecurity/DisarmWithCode"; //?param=" + encryptData(dataCnt);

  var header =
    "MACID:" + this.mac + ",Path:" + hPath + "/AdvancedSecurity/DisarmWithCode";
  if (this.debug)
    this.log(
      "[disarmAlarm] About to call API with, url:" +
        url +
        " dataCnt: " +
        dataCnt +
        " header: " +
        header +
        " api_key_enc: " +
        this.api_key_enc
    );
  callAPI_POST.apply(this, [
    url,
    dataCnt,
    dataCnt.length,
    CryptoJS.HmacSHA1(header, this.api_key_enc),
    finishDisarming,
  ]);

  function finishDisarming(value) {
    callback(null);
  }
}

function decryptData(data) {
  var encrypted = {};
  encrypted.ciphertext = CryptoJS.enc.Base64.parse(data);
  var decrypted = CryptoJS.AES.decrypt(
    encrypted,
    CryptoJS.enc.Hex.parse(this.api_key_enc),
    {
      iv: CryptoJS.enc.Hex.parse(this.api_iv_enc),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    }
  );
  if (this.debug)
    this.log(
      "[decryptData] Returning: " + decrypted.toString(CryptoJS.enc.Latin1)
    );
  return decrypted.toString(CryptoJS.enc.Latin1);
}

function encryptData(data) {
  var encString = CryptoJS.AES.encrypt(
    data,
    CryptoJS.enc.Hex.parse(this.api_key_enc),
    {
      iv: CryptoJS.enc.Hex.parse(this.api_iv_enc),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    }
  );
  return encodeURIComponent(encString);
}

// Get API Keys from the tuxedo unit
// Create an API request with the cookie jar turned on

async function getAPIKeys() {
  // Create an API request with the cookie jar turned on
  if (this.debug) this.log("[getAPIKeys] getAPIKeys called and immediately returned");
  return
  try {
    var tuxApiUrl = protocol + "://" + this.host;
    if (this.port) tuxApiUrl += ":" + this.port;
    tuxApiUrl += "/tuxedoapi.html";

    const gotCookieJar = new CookieJar();

    const options = {
      method: "GET",
      headers: {
        "User-Agent": "homebridge",
      },
      cookieJar: gotCookieJar,
      https: {
        rejectUnauthorized: false,
      },
    };

    if (this.debug) this.log("About to call, URL: " + tuxApiUrl);
    if (this.debug)
      this.log("Options: " + inspect(options, false, null, true));

    var response = await got(tuxApiUrl, options);

    var root = parse(response.body);
    var readit = root.querySelector("#readit");

    if (readit) {
      this.api_key_enc = readit
        .getAttribute("value")
        .toString()
        .substring(0, 64);
      this.api_iv_enc = readit
        .getAttribute("value")
        .toString()
        .substring(64, 96);

      if (this.debug) this.log("[getAPIKeys] Successfully retrieved keys");
      this.init();
    } else {
      if (
        root.querySelector("h1").structuredText ==
        "Max Number Of Connections In Use.Please Try Again."
      ) {
        this.log(
          "[getAPIKeys] Max tuxedo connections exceeded. Will retry in 3 mins."
        );
        
        setTimeout(() => {
          (async () => {
            await getAPIKeys.call(this);
          })();
        }, 180000);
      }
    }
  } catch (error) {
    if (error.code == "EPROTO") {
      this.log(
        "[getAPIKeys] This likely an issue with strict openSSL configuration, see: https://github.com/lockpicker/homebridge-honeywell-tuxedo-touch/issues/1"
      );
    } else {
      this.log("[getAPIKeys] Error retrieving keys from the tuxedo unit. Please ensure 'Authentication for web server local access' is disabled on the tuxedo unit. Will retry in 3 mins.");

      if (this.debug) this.log(error);
    }
    // On error, retry in some time
    setTimeout(() => {
      getAPIKeys.call(this);
    }, 180000);
  }
}