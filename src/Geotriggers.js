(function (root, factory) {

  // Node.
  if(typeof module === 'object' && typeof module.exports === 'object') {
    XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
    exports = module.exports = factory();
  }

  // AMD.
  if(typeof define === 'function' && define.amd) {
    define(factory);
  }

  // Browser Global.
  if(typeof window === "object") {
    root.Geotriggers = factory();
  }

}(this, function() {
  /*
  Configuration Variables
  -----------------------------------
  */
  var version        = "0.0.1";
  var geotriggersUrl = "https://geotriggersdev.arcgis.com";
  var tokenUrl = "https://devext.arcgis.com/sharing/oauth2/token";
  var registerDeviceUrl = "https://devext.arcgis.com/sharing/oauth2/registerDevice";
  var exports = {};

  /*
  Custom Deferred Callbacks.
  -----------------------------------
  */

  Deferred = function Deferred() {
    this._thens = [];
  };

  Deferred.prototype = {
    then: function (onResolve, onReject) {
      // capture calls to then()
      this._thens.push({ resolve: onResolve, reject: onReject });
      return this;
    },
    success: function(onResolve){
      this._thens.push({ resolve: onResolve });
      return this;
    },
    error: function(onReject){
      this._thens.push({ reject: onReject });
      return this;
    },
    resolve: function (val) {
      this._complete('resolve', val);
    },
    reject: function (ex) {
      this._complete('reject', ex);
    },
    _complete: function (which, arg) {
      // switch over to sync then()
      this.then = (which === 'resolve') ?
        function (resolve, reject) { resolve(arg); } :
        function (resolve, reject) { reject(arg); };
      // disallow multiple calls to resolve or reject
      this.resolve = this.reject =
        function () { throw new Error('Deferred already completed.'); };
      // complete all waiting (async) then()s
      for (var i = 0; i < this._thens.length; i++) {
        var aThen = this._thens[i];
        if(aThen[which]) {
          aThen[which](arg);
        }
      }
      delete this._thens;
    }
  };

  exports.Deferred = Deferred;

  /*
  Main Session Object
  -----------------------------------
  */

  function Session(options){
    this._requestQueue = [];
    this._events = {};
    var defaults = {
      session: {},
      preferLocalStorage: true,
      persistSession: true,
      geotriggersUrl: geotriggersUrl,
      tokenUrl: tokenUrl,
      registerDeviceUrl: registerDeviceUrl,
      debug: false
    };

    // set applicaiton id
    if(!options.applicationId && !options.session) {
      throw new Error("Geotriggers.Session requires an `applicationId` or a `session`.");
    }

    // mixin defaults and options into `this`
    util.mixin(this, util.merge(defaults, options));

    this.authenticatedAs = (this.applicationId && this.applicationSecret) ? "applicaiton" : "device";
    this.key = "_geotriggers_" + this.authenticatedAs + "_" + this.applicationId;

    // restore an old session from a passed object (node) or a persisted session (browser)
    if(options.session) {
      this.log("Geotriggers.Session : mixing in passed session");
      util.mixin(this, options.session);
    } else if(this.persistSession) {
      this.log("Geotriggers.Session : attempting to restore saved session");
      session.restore.call(this);
    }

    // if there is an access token and it is after when the token expires or there is no access token or an access_token and no refresh token
    if((this.accessToken && (Date.now() > new Date(this.expiresOn).getTime())) || !this.accessToken){
      this.log("accessToken does not exist or has expired");
      this.refresh();
    }
  }

  Session.prototype.get = function(method, options){
    options.type = "GET";
    options.method = method;
    return makeRequest.call(this, options);
  };
  Session.prototype.post = function(method, options){
    options.type = "POST";
    options.method = method;
    return makeRequest.call(this, options);
  };
  Session.prototype.authenticated = function(){
    return !!this.accessToken;
  };
  Session.prototype.destroy = function(){
    session.destroy.call(this);
  };
  Session.prototype.runQueue = function(){
    for (var i = 0; i < this._requestQueue.length; i++) {
      var request = this._requestQueue[i];
      makeRequest.call(this, request.options, request.deferred);
    }
  };
  Session.prototype.refresh = function(){
    // if we have an application secret just request a new token
    if(this.applicationSecret){
      this.post(this.tokenUrl, {
        params: {
          client_id: this.applicationId,
          client_secret: this.applicationSecret,
          f: "json",
          grant_type: "client_credentials"
        },
        authCall: true
      }).then(util.bind(this, function(response){
        this.accessToken = response.access_token;
        this.expiresOn = new Date(new Date().getTime() + ((response.expires_in-(60*5)) *1000));
      }), util.bind(this, this._authError)).then(util.bind(this, this._processAuth));

    // if we have a refresh token lets use it to get a new token
    } else if (this.refreshToken){
      this.post(this.tokenUrl, {
        params: {
          client_id: this.applicationId,
          refresh_token: this.refreshToken,
          f: "json",
          grant_type: "refresh_token"
        },
        authCall: true
      }).then(util.bind(this, function(response){
        this.accessToken = response.access_token;
        this.refreshToken = response.refresh_token;
        this.expiresOn = new Date(new Date().getTime() + ((response.expires_in-(60*5)) *1000));
      }), util.bind(this, this._authError)).then(util.bind(this, this._processAuth));

    // else register a new device
    } else {
      this.post(this.registerDeviceUrl, {
        params: {
          client_id: this.applicationId,
          f: "json"
        },
        authCall: true
      }).then(util.bind(this, function(response){
        this.deviceId = response.device.deviceId;
        this.accessToken = response.deviceToken.access_token;
        this.refreshToken = response.deviceToken.refresh_token;
        this.expiresOn = new Date(new Date().getTime() + ((response.deviceToken.expires_in-(60*5)) *1000));
      }), util.bind(this, this._authError)).then(util.bind(this, this._processAuth));
    }

  };
  Session.prototype.toJSON = function(){
    var obj = {};
      for (var key in this) {
        if (this.hasOwnProperty(key) && this[key] && !key.match(/^_.+/)) {
          obj[key] = this[key];
        }
      }
      return obj;
  };
  Session.prototype.on = function(type, listener){
    if (typeof this._events[type] === "undefined"){
      this._events[type] = [];
    }

    this._events[type].push(listener);
  };
  Session.prototype.emit = function(type){
    var args = [].splice.call(arguments,1);
    if (this._events[type] instanceof Array){
      var listeners = this._events[type];
      for (var i=0, len=listeners.length; i < len; i++){
        listeners[i].apply(this, args);
      }
    }
  };
  Session.prototype.off = function(type, listener){
    if (this._events[type] instanceof Array){
      var listeners = this._events[type];
      for (var i=0, len=listeners.length; i < len; i++){
        if (listeners[i] === listener){
          listeners.splice(i, 1);
          break;
        }
      }
    }
  };
  Session.prototype._processAuth = function(response){
    session.persist.call(this);
    this.runQueue();
    this.emit("authentication:success");
    this.emit("authenticated");
  };
  Session.prototype._authError = function(error){
    this.emit("authentication:failure");
  };
  Session.prototype.log = function(){
    var args = Array.prototype.slice.apply(arguments);
    if(this.debug){
      util.log.apply(this, args);
    }
  };

  exports.Session = Session;

  /*
  Makes AJAX Requests
  -----------------------------------
  */
  function makeRequest(options, dfd) {
    this.log("Geotriggers.Session : starting request");

    // make a new deferred for callbacks
    var deferred = new exports.Deferred() || dfd;

    // if we are not authenticated yet save these options and deferred for later
    if(!this.authenticated() && !options.authCall){
      this.log("Geotriggers.Session : not authenticated queueing request");
      this._requestQueue.push({
        deferred: deferred,
        options: options
      });
      return deferred;
    }

    // empty var for httpRequest which is set later
    var httpRequest;

    // set defaults for parameters, callback, XHR, and toggles
    var defaults = {
      parameters: {},
      callback: null,
      returnXHR: false,
      addCallbacksToDeferred: true
    };

    //merge settings and defaults
    var settings = util.merge(defaults, options);
    this.log("Geotriggers.Session : mergeing request defaults and ");
    // assume this is a request to getriggers is it doesnt start with (http|https)://
    var geotriggersRequest = settings.method.match(/^https?:\/\//);

    // create the url for the request
    var url = (geotriggersRequest) ? settings.method : this.geotriggersUrl + "/" + settings.method;

    // if the user supplied a callback and the callback has NOT been applied to the deferred
    if(settings.callback && options.addCallbacksToDeferred) {
      deferred.then(function(result){
        settings.callback(null, result);
      }, function(error){
        settings.callback(error, null);
      });
    }

    // callback for handling a successful request
    var handleSuccessfulResponse = function(){
      var json = JSON.parse(httpRequest.responseText);
      var response = (json.error) ? null : json;
      var error = (json.error) ? json.error : null;

      // did our token expire?
      // if it didn't resolve or reject the callback
      // if it did refresh the auth and run the request again
      if(error && error.type === "expired_token"){
        // dont add the settings.callback function to the deferred next time around;
        options.addCallbacksToDeferred = false;
        // push our request options and deferred into the request queue
        this._requestQueue.push({
          options: options,
          deferred: deferred
        });
        // refresh the auth
        this.refresh();
      } else {
        if(settings.returnXHR && !error){
          deferred.resolve(httpRequest);
        } else if (settings.returnXHR && error){
          deferred.reject(httpRequest);
        } else if (!error){
          deferred.resolve(response);
        } else if (error){
          deferred.reject(error);
        } else {
          deferred.reject({
            type: "unexpected_response",
            message: "the api returned a non json or unexpected data"
          });
        }
      }
    };

    // callback for handling an http error
    var handleErrorResponse = function(){
      var error = {
        type: "http_error",
        message: "your request could not be completed"
      };
      deferred.reject(error);
      events.fire("request:end");
    };

    // callback for handling state change
    var handleStateChange = function(){
      if(httpRequest instanceof XMLHttpRequest && httpRequest.readyState === 4 && httpRequest.status < 400){
        handleSuccessfulResponse();
      } else if(httpRequest instanceof XMLHttpRequest && httpRequest.readyState === 4 && httpRequest.status >= 400) {
        handleErrorResponse();
      } else if(httpRequest instanceof XMLHttpRequest) {
        // die and do nothing to avoid an error when we check for XDomainRequest in browsers that dont have it
      } else if (httpRequest instanceof XDomainRequest) {
        handleSuccessfulResponse();
      }
    };

    // use XDomainRequest (ie8) or XMLHttpRequest (standard)
    if (typeof XDomainRequest !== "undefined") {
      httpRequest = new XDomainRequest();
      httpRequest.onload = handleStateChange;
      httpRequest.onerror = handleErrorResponse;
      httpRequest.ontimeout = handleErrorResponse;
    } else if (typeof XMLHttpRequest !== "undefined") {
      httpRequest = new XMLHttpRequest();
      httpRequest.onreadystatechange = handleStateChange;
    } else {
      throw new Error("This browser does not support XMLHttpRequest or XDomainRequest");
    }

    // Convert parameters to form vars for transport
    var queryString = util.toQueryString(settings.params);

    // is we are authenticated and this is a geotriggers request and this is not and authCall
    if(this.authenticated() && geotriggersRequest && !options.authCall){
      httpRequest.setRequestHeader('Authentication', 'Bearer '+ this.accessToken);
    }

    // make the request
    switch (settings.type) {
      case "GET":
        httpRequest.open("GET", url + "?" + queryString);
        httpRequest.send(null);
        break;
      case "POST":
        httpRequest.open("POST", url);
        if(httpRequest instanceof XMLHttpRequest){
          httpRequest.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
        }
        httpRequest.send(queryString);
        break;
    }

    // return the deferred
    return deferred;
  }

  /*
  General Purpose Utilities
  -----------------------------------
  */

  var util = {
    bind: function(context, func) {
      var bound, args;
      if (typeof func !== "function") throw new TypeError();
      if (typeof Function.prototype.bind == 'function') return func.bind(context);
      args = Array.prototype.slice.call(arguments, 2);
      return bound = function() {
        if (!(this instanceof bound)) return func.apply(context, args.concat(Array.prototype.slice.call(arguments)));
        ctor.prototype = func.prototype;
        var self = new ctor();
        var result = func.apply(self, args.concat(Array.prototype.slice.call(arguments)));
        if (Object(result) === result) return result;
        return self;
      };
    },
    /* Merge Object 1 and Object 2. Properties from Object 2 will override properties in Ojbect 1 */
    merge: function(obj1, obj2){
      var obj3 = {};
      for (var obj1attr in obj1) {
        if(obj1.hasOwnProperty(obj1attr)){
          obj3[obj1attr] = obj1[obj1attr];
        }
      }
      for (var obj2attr in obj2) {
        if(obj2.hasOwnProperty(obj2attr)){
          obj3[obj2attr] = obj2[obj2attr];
        }
      }
      return obj3;
    },
    mixin: function(target, mixin){
      for (var attr in mixin) {
        if(mixin.hasOwnProperty(attr)){
          target[attr] = mixin[attr];
        }
      }
      return target;
    },
    s4: function(){
      return Math.floor(Math.random() * 0x10000).toString(16);
    },
    guid: function(){
      return (util.S4() + util.S4() + "-" + util.S4() + "-" + util.S4() + "-" + util.S4() + "-" + util.S4() + util.S4() + util.S4());
    },
    log: function(){
      var args = Array.prototype.slice.apply(arguments);
      if (typeof console !== undefined && console.log) {
        console.log.apply(console, args);
      }
    },
    toQueryString: function(obj, parentObject) {
      if( typeof obj !== 'object' ){
        return '';
      }
      var rv = '';
      for(var prop in obj) {
        if (obj.hasOwnProperty(prop)) {

          var qname = (parentObject) ? parentObject + '.' + prop : prop;

          // Expand Arrays
          if (obj[prop] instanceof Array) {
            for( var i = 0; i < obj[prop].length; i++ ){
              if( typeof obj[prop][i] === 'object' ){
                rv += '&' + util.toQueryString( obj[prop][i], qname );
              } else{
                rv += '&' + encodeURIComponent(qname) + '=' + encodeURIComponent( obj[prop][i] );
              }
            }
          // Expand Dates
          } else if (obj[prop] instanceof Date) {
            rv += '&' + encodeURIComponent(qname) + '=' + obj[prop].getTime();

          // Expand Objects
          } else if (obj[prop] instanceof Object) {
            // If they're String() or Number() etc
            if (obj.toString && obj.toString !== Object.prototype.toString){
              rv += '&' + encodeURIComponent(qname) + '=' + encodeURIComponent( obj[prop].toString() );
            // Otherwise, we want the raw properties
            } else{
              rv += '&' + util.toQueryString(obj[prop], qname);
            }
          // Output non-object
          } else {
            rv += '&' + encodeURIComponent(qname) + '=' + encodeURIComponent( obj[prop] );
          }
        }
      }
      return rv.replace(/^&/,'');
    }
  };

  /*
  Utilities for manipulating sessions
  -----------------------------------
  */

  var session = (function(){
    var s = {};

    var localStorage = {
      set:function(key, value){
        window.localStorage.setItem(key, JSON.stringify(value));
      },
      get: function(key){
        return JSON.parse(window.localStorage.getItem(key));
      },
      erase: function(key){
        window.localStorage.removeItem(key);
      }
    };

    var cookie = {
      get: function(key) {
        // Still not sure that "[a-zA-Z0-9.()=|%/_]+($|;)" match *all* allowed characters in cookies
        var tmp =  document.cookie.match((new RegExp(key +'=[a-zA-Z0-9.()=|%/_]+($|;)','g')));
        if(!tmp || !tmp[0]){
          return null;
        } else {
          return JSON.parse(tmp[0].substring(key.length+1,tmp[0].length).replace(';','')) || null;
        }
      },

      set: function(key, value, secure) {
        var cookie = [
          key+'='+JSON.stringify(value),
          'path=/',
          'domain='+window.location.host
        ];

        var expiration_date = new Date();
        expiration_date.setFullYear(expiration_date.getFullYear() + 1);
        cookie.push(expiration_date.toGMTString());

        if (secure){
          cookie.push('secure');
        }
        return document.cookie = cookie.join('; ');
      },

      erase: function(key) {
        document.cookie = key + "; " + new Date(0).toUTCString();
      }
    };

    var hasLocalStorage = (typeof window === "object" && typeof window.localStorage === "object") ? true : false;
    var hasCookies = (typeof document === "object" && typeof document.cookie === "string") ? true : false;

    return {
      persist:function(){
        var value = {};
        if(this.applicationSecret){ value.applicationSecret = this.applicationSecret; }
        if(this.accessToken){ value.accessToken = this.accessToken; }
        if(this.refreshToken){ value.refreshToken = this.refreshToken; }
        if(this.preferLocalStorage && hasLocalStorage){
          localStorage.set(this.key, value);
        } else if (hasCookies) {
          cookie.set(this.key, value);
        }
      },
      restore: function(){
        var storedSession = {};
        if(this.preferLocalStorage && hasLocalStorage){
          storedSession = localStorage.get(this.key);
        } else if (hasCookies) {
          storedSession = cookie.get(this.key);
        }
        util.mixin(this, storedSession);
      },
      destroy: function(){
        if(this.preferLocalStorage && hasLocalStorage){
          localStorage.erase(this.key);
        } else if (hasCookies) {
          cookie.erase(this.key);
        }
      }
    };
  }());

  return exports;
}));