// The page's side of the Mac app's bridge (Sources/QTask/Bridge.swift).
//
// Runs before the web client's bundle. The client only ever talks to its backend with
// fetch('/api/...') and fetch('/health'); this replaces fetch for those paths with a
// message to the app, which forwards them to the local server (loopback, with this
// launch's device token, neither of which the page ever sees).
//
// The web view itself has no network: the page's content security policy has
// connect-src 'none', so a fetch, XHR, WebSocket or EventSource that slips past this
// replacement is refused by the engine rather than sent. Anything this does not
// recognise as the app's own API is rejected here too, and never reaches native code.
(function () {
  'use strict';
  if (window.__qtaskDesktop) return;
  var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.qtask;
  if (!handler) return;

  // The hint src/runtime.ts looks for before it asks /api/version what it is talking to.
  Object.defineProperty(window, '__QTASK_NATIVE__', { value: Object.freeze({ platform: 'macos' }) });

  function post(msg) {
    return handler.postMessage(msg);
  }

  function bytesToBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function base64ToBytes(b64) {
    var bin = atob(b64 || '');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var nextId = 1;

  // Only the app's own API goes native. Same-origin only: a URL naming another host is
  // not rewritten, it is left to fail against the content security policy.
  function isApi(url) {
    if (url.origin !== location.origin) return false;
    return url.pathname === '/health' || url.pathname.indexOf('/api/') === 0;
  }

  var nativeFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var request;
    try {
      request = new Request(input, init);
    } catch (e) {
      return Promise.reject(e);
    }
    var url = new URL(request.url, location.href);
    if (!isApi(url)) return nativeFetch(input, init);

    var signal = request.signal;
    if (signal && signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

    var headers = {};
    request.headers.forEach(function (value, key) {
      headers[key] = value;
    });
    var hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    var bodyPromise = hasBody ? request.arrayBuffer() : Promise.resolve(null);
    var method = request.method;
    var path = url.pathname + url.search;

    var result = bodyPromise
      .then(function (buf) {
        return post({
          op: 'fetch',
          id: nextId++,
          method: method,
          path: path,
          headers: headers,
          body: buf && buf.byteLength ? bytesToBase64(new Uint8Array(buf)) : null,
        });
      })
      .then(
        function (res) {
          var status = res.status;
          var nullBody = status === 101 || status === 204 || status === 205 || status === 304;
          var payload = nullBody ? null : res.text !== undefined && res.text !== null ? res.text : base64ToBytes(res.body);
          var response = new Response(payload, {
            status: status < 200 || status > 599 ? 502 : status,
            headers: res.headers || {},
          });
          try {
            Object.defineProperty(response, 'url', { value: url.href });
          } catch (e) {}
          if (method !== 'GET' && method !== 'HEAD' && status >= 200 && status < 300) {
            // Lets the app refresh the Dock badge without polling.
            post({ op: 'changed', path: url.pathname }).catch(function () {});
          }
          return response;
        },
        function (err) {
          throw new TypeError('Load failed: ' + (err && err.message ? err.message : err));
        }
      );

    if (!signal) return result;
    return new Promise(function (resolve, reject) {
      signal.addEventListener('abort', function () {
        reject(new DOMException('Aborted', 'AbortError'));
      });
      result.then(resolve, reject);
    });
  };

  // Menu commands and other things the app tells the page.
  window.__qtaskDesktop = Object.freeze({
    event: function (msg) {
      if (msg && msg.name === 'command') {
        window.dispatchEvent(new CustomEvent('qtask:command', { detail: msg.payload }));
      }
    },
  });
})();
