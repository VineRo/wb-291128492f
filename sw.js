const CACHE_NAME = "world-brief-v2.4";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./apple-touch-icon.png?v=4",
  "./icon-512.png?v=4",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Normalize cache key for encrypted data files (strip ?t=... cache-buster)
  const isEncData = url.pathname.endsWith(".enc");
  const cacheKey = isEncData ? new Request(url.origin + url.pathname) : req;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(cacheKey))
  );
});
