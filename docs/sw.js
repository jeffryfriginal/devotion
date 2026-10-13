// Service worker: caches the app shell only. Apps Script requests are
// cross-origin POSTs, which this worker never touches, so devotions and the
// password are never stored on the device by this file.
//
// Bump CACHE when you change the shell list below.
const CACHE = "devotion-shell-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never touch POSTs
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch Apps Script / GitHub

  // Pages: network first so edits show up immediately, cache as fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Icons / manifest: cache first.
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
