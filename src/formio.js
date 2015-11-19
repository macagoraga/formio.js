'use strict'

module.exports = function(_baseUrl, _noalias, _domain) {
  require('whatwg-fetch');
  var Q = require('Q');
  var EventEmitter = require('eventemitter3');

  // Prefix used with offline cache entries in localStorage
  var OFFLINE_CACHE_PREFIX = 'formioCache-';
  var OFFLINE_QUEUE_KEY = 'formioOfflineQueue';

// The default base url.
  var baseUrl = _baseUrl || '';
  var noalias = _noalias || false;

  // The temporary GET request cache storage
  var cache = {};

  // The persistent offline cache storage
  var offlineCache = {};

  // The queue of submissions made offline
  var offlineQueue = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');

  // The current request from the offline queue that is being processed
  var currentOfflineRequest = null;

  // Flag to force offline mode
  var forceOffline = false;

  // Flag to set if Formio should auto dequeue offline requests when online
  var autoDequeue = true;

  // Promise that resolves when ready to make requests
  var ready = Q();

  /**
   * Returns parts of the URL that are important.
   * Indexes
   *  - 0: The full url
   *  - 1: The protocol
   *  - 2: The hostname
   *  - 3: The rest
   *
   * @param url
   * @returns {*}
   */
  var getUrlParts = function(url) {
    return url.match(/^(http[s]?:\/\/)([^/]+)($|\/.*)/);
  };

  var serialize = function(obj) {
    var str = [];
    for(var p in obj)
      if (obj.hasOwnProperty(p)) {
        str.push(encodeURIComponent(p) + "=" + encodeURIComponent(obj[p]));
      }
    return str.join("&");
  }

  /**
   * Removes duplicate forms from offline cached project.
   * Duplicates can occur if form is renamed (old and new
   * stored under different names but have same id/path).
   * NOTE: modifies the given object
   *
   * @param project Cached project
   */
  var removeCacheDuplicates = function(project) {
    Object.keys(project.forms).forEach(function(name) {
      var form = project.forms[name];
      if (!form) { // form was deleted
        return;
      }
      Object.keys(project.forms).forEach(function(otherName) {
        var otherForm = project.forms[otherName];
        if ((form._id === otherForm._id || form.path === otherForm.path) &&
            new Date(otherForm.modified) < new Date(form.modified)) {
            delete project.forms[otherName];
        }
      });
    });
  };

  // The formio class.
  var Formio = function(path) {

    // Ensure we have an instance of Formio.
    if (!(this instanceof Formio)) { return new Formio(path); }
    if (!path) {
      // Allow user to create new projects if this was instantiated without
      // a url
      this.projectUrl = baseUrl + '/project';
      this.projectsUrl = baseUrl + '/project';
      this.projectId = false;
      this.query = '';
      return;
    }

    // Initialize our variables.
    this.projectsUrl = '';
    this.projectUrl = '';
    this.projectId = '';
    this.formUrl = '';
    this.formsUrl = '';
    this.formId = '';
    this.submissionsUrl = '';
    this.submissionUrl = '';
    this.submissionId = '';
    this.actionsUrl = '';
    this.actionId = '';
    this.actionUrl = '';
    this.query = '';

    // Normalize to an absolute path.
    if ((path.indexOf('http') !== 0) && (path.indexOf('//') !== 0)) {
      baseUrl = baseUrl ? baseUrl : window.location.href.match(/http[s]?:\/\/api./)[0];
      path = baseUrl + path;
    }

    var hostparts = getUrlParts(path);
    var parts = [];
    var hostName = hostparts[1] + hostparts[2];
    path = hostparts.length > 3 ? hostparts[3] : '';
    var queryparts = path.split('?');
    if (queryparts.length > 1) {
      path = queryparts[0];
      this.query = '?' + queryparts[1];
    }

    // See if this is a form path.
    if ((path.search(/(^|\/)(form|project)($|\/)/) !== -1)) {

      // Register a specific path.
      var registerPath = function(name, base) {
        this[name + 'sUrl'] = base + '/' + name;
        var regex = new RegExp('\/' + name + '\/([^/]+)');
        if (path.search(regex) !== -1) {
          parts = path.match(regex);
          this[name + 'Url'] = parts ? (base + parts[0]) : '';
          this[name + 'Id'] = (parts.length > 1) ? parts[1] : '';
          base += parts[0];
        }
        return base;
      }.bind(this);

      // Register an array of items.
      var registerItems = function(items, base, staticBase) {
        for (var i in items) {
          var item = items[i];
          if (item instanceof Array) {
            registerItems(item, base, true);
          }
          else {
            var newBase = registerPath(item, base);
            base = staticBase ? base : newBase;
          }
        }
      };

      registerItems(['project', 'form', ['submission', 'action']], hostName);
    }
    else {

      // This is an aliased url.
      this.projectUrl = hostName;
      this.projectId = (hostparts.length > 2) ? hostparts[2].split('.')[0] : '';
      var subRegEx = new RegExp('\/(submission|action)($|\/.*)');
      var subs = path.match(subRegEx);
      this.pathType = (subs && (subs.length > 1)) ? subs[1] : '';
      path = path.replace(subRegEx, '');
      path = path.replace(/\/$/, '');
      this.formsUrl = hostName + '/form';
      this.formUrl = hostName + path;
      this.formId = path.replace(/^\/+|\/+$/g, '');
      var items = ['submission', 'action'];
      for (var i in items) {
        var item = items[i];
        this[item + 'sUrl'] = hostName + path + '/' + item;
        if ((this.pathType === item) && (subs.length > 2) && subs[2]) {
          this[item + 'Id'] = subs[2].replace(/^\/+|\/+$/g, '');
          this[item + 'Url'] = hostName + path + subs[0];
        }
      }
    }
  };

  /**
   * Load a resource.
   *
   * @param type
   * @returns {Function}
   * @private
   */
  var _load = function(type) {
    var _id = type + 'Id';
    var _url = type + 'Url';
    return function(query) {
      if (typeof query === 'object') {
        query = '?' + serialize(query.params);
      }
      if (!this[_id]) { return Q.reject('Missing ' + _id); }
      return this.makeRequest(type, this[_url] + this.query);
    };
  };

  /**
   * Save a resource.
   *
   * @param type
   * @returns {Function}
   * @private
   */
  var _save = function(type) {
    var _id = type + 'Id';
    var _url = type + 'Url';
    return function(data) {
      var method = this[_id] ? 'put' : 'post';
      var reqUrl = this[_id] ? this[_url] : this[type + 'sUrl'];
      cache = {};
      return this.makeRequest(type, reqUrl + this.query, method, data);
    };
  };

  /**
   * Delete a resource.
   *
   * @param type
   * @returns {Function}
   * @private
   */
  var _delete = function(type) {
    var _id = type + 'Id';
    var _url = type + 'Url';
    return function() {
      if (!this[_id]) { Q.reject('Nothing to delete'); }
      cache = {};
      return this.makeRequest(type, this[_url], 'delete');
    };
  };

  /**
   * Resource index method.
   *
   * @param type
   * @returns {Function}
   * @private
   */
  var _index = function(type) {
    var _url = type + 'Url';
    return function(query) {
      query = query || '';
      if (typeof query === 'object') {
        query = '?' + serialize(query.params);
      }
      return this.makeRequest(type, this[_url] + query);
    };
  };

  // Returns cached results if offline, otherwise calls Formio.request
  Formio.prototype.makeRequest = function(type, url, method, data) {
    var self = this;
    var offline = Formio.isOffline();
    method = (method || 'GET').toUpperCase();

    return ready // Wait until offline caching is finished
    .then(function() {
      // Try to get offline cached response if offline
      var cache = offlineCache[self.projectId];

      // Form GET
      if (type === 'form' && method === 'GET' && offline) {
        if (!cache || !cache.forms) {
          return null;
        }
        // Find and return form
        return Object.keys(cache.forms).reduce(function(result, name) {
          if (result) return result;
          // TODO: verify this works with longform URLs too
          var form = cache.forms[name];
          if (form._id === self.formId || form.path === self.formId) return form;
        }, null);
      }

      // Form INDEX
      if (type === 'forms' && method === 'GET' && offline) {
        if (!cache || !cache.forms) {
          return null;
        }
        return cache.forms;
      }

      // Submission POST
      if (type === 'submission' && method === 'POST' && offline) {
        // Store request in offline queue
        offlineQueue.push({
            type: type,
            url: url,
            method: method,
            data: data
        });
        localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(offlineQueue));
        Formio.offline.emit('queue', offlineQueue[offlineQueue.length - 1]);

        // Send fake response
        var user = Formio.getUser();
        return {
            // _id: can't give an _id,
            owner: user ? user._id : null,
            offline: true,
            form: self.formId,
            data: data,
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            externalIds: [],
            roles: []
        };
      }

    })
    .then(function(result) {
      // Make regular request if no offline response returned
      return result || Formio.request(url, method, data);
    })
    .then(function(result) {
      // Check if need to update cache after request
      var cache = offlineCache[self.projectId];
      if (!cache) return result; // Skip caching

      if (type === 'form' && method !== 'DELETE') {
        cache.forms[result.name] = result;
      }
      else if (type === 'form' && method === 'DELETE') {
        delete cache.forms[result.name];
      }
      else if (type === 'forms' && method === 'GET') {
        // Don't replace all forms, as some may be omitted due to permissions
        result.forEach(function(form) {
          cache.forms[form.name] = form;
        });
      }
      else {
        // Nothing to cache
        return result;
      }

      // Update localStorage
      removeCacheDuplicates(cache); // Clean up duplicates
      localStorage.setItem(OFFLINE_CACHE_PREFIX + self.projectId, JSON.stringify(cache));
      return result;
    });
  };

  // Define specific CRUD methods.
  Formio.prototype.loadProject = _load('project');
  Formio.prototype.saveProject = _save('project');
  Formio.prototype.deleteProject = _delete('project');
  Formio.prototype.loadForm = _load('form');
  Formio.prototype.saveForm = _save('form');
  Formio.prototype.deleteForm = _delete('form');
  Formio.prototype.loadForms = _index('forms');
  Formio.prototype.loadSubmission = _load('submission');
  Formio.prototype.saveSubmission = _save('submission');
  Formio.prototype.deleteSubmission = _delete('submission');
  Formio.prototype.loadSubmissions = _index('submissions');
  Formio.prototype.loadAction = _load('action');
  Formio.prototype.saveAction = _save('action');
  Formio.prototype.deleteAction = _delete('action');
  Formio.prototype.loadActions = _index('actions');
  Formio.prototype.availableActions = function() { return Formio.request(this.formUrl + '/actions'); };
  Formio.prototype.actionInfo = function(name) { return Formio.request(this.formUrl + '/actions/' + name); };

  // Static methods.
  Formio.loadProjects = function() { return this.request(baseUrl + '/project'); };
  Formio.request = function(url, method, data) {
    if (!url) { return Q.reject('No url provided'); }
    method = (method || 'GET').toUpperCase();
    var cacheKey = btoa(url);

    return Q().then(function() {
      // Get the cached promise to save multiple loads.
      if (method === 'GET' && cache.hasOwnProperty(cacheKey)) {
        return cache[cacheKey];
      }
      else {
        return Q()
        .then(function() {
          // Set up and fetch request
          var headers = new Headers({
            'Accept': 'application/json',
            'Content-type': 'application/json; charset=UTF-8'
          });
          var token = Formio.getToken();
          if (token) {
            headers.append('x-jwt-token', token);
          }

          var options = {
            method: method,
            headers: headers,
            mode: 'cors'
          };
          if (data) {
            options.body = JSON.stringify(data);
          }

          return fetch(url, options);
        })
        .catch(function(err) {
          err.message = 'Could not connect to API server (' + err.message + ')';
          throw err;
        })
        .then(function(response) {
          // Handle fetch results
          if (response.ok) {
            var token = response.headers.get('x-jwt-token');
            if (response.status >= 200 && response.status < 300 && token && token !== '') {
              Formio.setToken(token);
            }
            // 204 is no content. Don't try to .json() it.
            if (response.status === 204) {
              return {};
            }
            return response.json();
          }
          else {
            if (response.status === 440) {
              Formio.setToken(null);
            }
            // Parse and return the error as a rejected promise to reject this promise
            return (response.headers.get('content-type').indexOf('application/json') !== -1 ?
              response.json() : response.text())
              .then(function(error){
                throw error;
              });
          }
        })
        .catch(function(err) {
          // Remove failed promises from cache
          delete cache[cacheKey];
          // Propagate error so client can handle accordingly
          throw err;
        });
      }
    })
    .then(function(result) {
      // Save the cache
      if (method === 'GET') {
        cache[cacheKey] = Q(result);
      }

      return result;
    });
  };

  Formio.setToken = function(token) {
    token = token || '';
    if (token === this.token) { return; }
    this.token = token;
    if (!token) {
      Formio.setUser(null);
      return localStorage.removeItem('formioToken');
    }
    localStorage.setItem('formioToken', token);
    Formio.currentUser(); // Run this so user is updated if null
  };
  Formio.getToken = function() {
    if (this.token) { return this.token; }
    var token = localStorage.getItem('formioToken') || '';
    this.token = token;
    return token;
  };
  Formio.setUser = function(user) {
    if (!user) {
      this.setToken(null);
      return localStorage.removeItem('formioUser');
    }
    localStorage.setItem('formioUser', JSON.stringify(user));
  };
  Formio.getUser = function() {
    return JSON.parse(localStorage.getItem('formioUser') || null);
  };

  Formio.setBaseUrl = function(url, _noalias) {
    baseUrl = url;
    noalias = _noalias;
    Formio.baseUrl = baseUrl;
  }
  Formio.clearCache = function() { cache = {}; };

  Formio.currentUser = function() {
    var user = this.getUser();
    if (user) { return Q(user) }
    var token = this.getToken();
    if (!token) { return Q(null) }
    return this.request(baseUrl + '/current')
    .then(function(response) {
      Formio.setUser(response);
      return response;
    });
  };

// Keep track of their logout callback.
  Formio.logout = function() {
    return this.request(baseUrl + '/logout').finally(function() {
      this.setToken(null);
      this.setUser(null);
      Formio.clearCache();
    }.bind(this));
  };
  Formio.fieldData = function(data, component) {
    if (!data) { return ''; }
    if (component.key.indexOf('.') !== -1) {
      var value = data;
      var parts = component.key.split('.');
      var key = '';
      for (var i = 0; i < parts.length; i++) {
        key = parts[i];

        // Handle nested resources
        if (value.hasOwnProperty('_id')) {
          value = value.data;
        }

        // Return if the key is not found on the value.
        if (!value.hasOwnProperty(key)) {
          return;
        }

        // Convert old single field data in submissions to multiple
        if (key === parts[parts.length - 1] && component.multiple && !Array.isArray(value[key])) {
          value[key] = [value[key]];
        }

        // Set the value of this key.
        value = value[key];
      }
      return value;
    }
    else {
      // Convert old single field data in submissions to multiple
      if (component.multiple && !Array.isArray(data[component.key])) {
        data[component.key] = [data[component.key]];
      }
      return data[component.key];
    }
  };

  /**
   * EventEmitter for offline mode events.
   * See Node.js documentation for API documentation: https://nodejs.org/api/events.html
   */
  Formio.offline = new EventEmitter();

  /**
   * Sets up a project to be cached offline
   * @param  url  The url to the project (same as you would pass to Formio constructor)
   * @param  path Optional. Path to local project.json definition to get initial project forms from if offline.
   * @return {[type]}      [description]
   */
  Formio.cacheOfflineProject = function(url, path) {
    var formio = new Formio(url);
    var projectId = formio.projectId;
    var projectUrl = formio.projectUrl;

    var projectPromise;
    // Offline
    // if (Formio.isOffline()) {
      // Try to return cached first
      var cached = localStorage.getItem(OFFLINE_CACHE_PREFIX + projectId);
      if (cached) {
        projectPromise = Q(JSON.parse(cached));
      }
      // Otherwise grab offline project definition
      else if (path) {
        projectPromise = fetch(path)
        .then(function(response) {
          return response.json();
        })
        .then(function(project) {
          Object.keys(project.forms.forms).forEach(function(formName) {
            // Set modified time as early as possible so any newer
            // form will override this one if there's a name conflict.
            project.forms[formName].created = new Date(0).toISOString();
            project.forms[formName].modified = new Date(0).toISOString();
          });
          return project;
        });
      }
      else {
        // Return an empty project so requests start caching offline.
        projectPromise = Q({ forms: {} });
      }
    // }
    // TODO: fix forms index endpoint to show forms you have permission to
    // // Online
    // else {
    //   // Load and use the latest list of forms
    //   projectPromise = formio.loadForms()
    //   .then(function(forms) {
    //     return {forms: forms}
    //   });
    // }


    // Add this promise to the ready chain
    return ready = ready.then(function() {
      return projectPromise.then(function(project) {
        localStorage.setItem(OFFLINE_CACHE_PREFIX + projectId, JSON.stringify(project));
        offlineCache[projectId] = project;
      })
    })
    .catch(function(err) {
      console.error('Error trying to cache offline storage:', err);
      // Swallow the error so failing caching doesn't halt the ready promise chain
    });
  };

  /**
   * Clears the offline cache. This will also stop previously
   * cached projects from caching future requests for offline access.
   */
  Formio.clearOfflineCache = function() {
    // Clear in-memory cache
    offlineCache = {};
    // Clear localStorage cache
    for(var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key.indexOf(OFFLINE_CACHE_PREFIX) === 0) {
        localStorage.removeItem(key);
      }
    }
  };

  /**
   * Forces Formio to go into offline mode.
   * @param offline
   */
  Formio.setOffline = function(offline) {
    var oldOffline = Formio.isOffline();
    forceOffline = offline;

    // If autoDequeue enabled and was offline before
    // and not now, start dequeuing
    if(autoDequeue && oldOffline && !Formio.isOffline()) {
      Formio.dequeueOfflineRequests();
    }
  };

  /**
   * @return true if Formio is in offline mode (forced or not),
   *         false otherwise
   */
  Formio.isOffline = function() {
    return forceOffline || !navigator.onLine;
  };

  Formio.setAutoDequeue = function(auto) {
    autoDequeue = auto;
  };

  /**
   * Attempts to send requests queued while offline.
   * Each request is sent one at a time. A request that
   * fails will emit the `formError` event on Formio.offline,
   * and stop dequeuing further requests.
   */
  Formio.dequeueOfflineRequests = function() {
    if(currentOfflineRequest || !offlineQueue.length) {
      return;
    }
    currentOfflineRequest = offlineQueue.shift();
    Formio.offline.emit('dequeue', currentOfflineRequest);
    Formio.request(currentOfflineRequest.url, currentOfflineRequest.method, currentOfflineRequest.data)
    .then(function(submission) {
      Formio.offline.emit('formSubmission', submission);
      localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(offlineQueue));

      // Continue to next queue item
      currentOfflineRequest = null;
      Formio.dequeueOfflineRequests();
    })
    .catch(function(err) {
      localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(offlineQueue));
      var request = currentOfflineRequest;
      currentOfflineRequest = null;
      Formio.offline.emit('formError', request);
      // Stop sending requests
    });
  };

  window.addEventListener('online', function() {
    if(autoDequeue) {
      Formio.dequeueOfflineRequests();
    }
  });


  return Formio;
};
