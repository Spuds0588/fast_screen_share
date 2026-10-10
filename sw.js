/* fast_screen_share service worker.
   Keeps the app shell available offline. Media and signalling are never cached. */

var CACHE = "fss-shell-v1";

var PRECACHE = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "vendor/peerjs.min.js",
  "vendor/qrcode.min.js"
];

/* Install: fill the cache one file at a time so a single 404 cannot abort the install. */
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(
        PRECACHE.map(function (url) {
          return cache.add(new Request(url, { cache: "reload" })).catch(function () {
            return undefined;
          });
        })
      );
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

/* Activate: drop caches written by older versions of this worker. */
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (key) {
          if (key !== CACHE) {
            return caches.delete(key);
          }
          return undefined;
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* Fetch a request and store a copy of a successful same-origin response. */
function refresh(request) {
  return fetch(request).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(CACHE).then(function (cache) {
        cache.put(request, copy);
      });
    }
    return response;
  });
}

/* Last resort when the network is gone and the cache has nothing: answer with 503
   instead of an undefined response, which would throw inside respondWith. */
function offline() {
  return new Response("Offline. Reconnect to reach the other browser.", {
    status: 503,
    statusText: "Offline",
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

function cachedOrOffline(request) {
  return caches.match(request).then(function (hit) {
    return hit || offline();
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;

  /* Only same-origin GETs are ours. Everything the signalling server and WebRTC need
     lives on another origin, so it is left untouched and always hits the network. */
  if (request.method !== "GET") { return; }
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) { return; }

  /* Documents: network first, so a new deploy is picked up, with the cached shell as
     the offline fallback. */
  if (request.mode === "navigate") {
    event.respondWith(
      refresh(request).catch(function () {
        return caches.match(request).then(function (hit) {
          return hit || caches.match("./").then(function (shell) {
            return shell || offline();
          });
        });
      })
    );
    return;
  }

  /* Other same-origin files: network first as well, so a new deploy is never masked
     by a stale copy of the app, with the cached copy as the offline fallback. */
  event.respondWith(
    refresh(request).catch(function () {
      return cachedOrOffline(request);
    })
  );
});
