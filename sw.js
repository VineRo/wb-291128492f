// App shell is versioned (replaced on every release); encrypted data lives in its
// own unversioned cache so offline issues survive app updates.
const SHELL_CACHE = "world-brief-shell-v2.12";
const DATA_CACHE = "world-brief-data-v1";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./app.js?v=12",
  "./apple-touch-icon.png?v=4",
  "./icon-512.png?v=4",
];

// ~360 KB per audio file, ~50 KB per issue: keeps offline storage around 5 MB.
const MAX_AUDIO_ENTRIES = 5;
const MAX_ISSUE_ENTRIES = 60;

const isEnc = (p) => p.endsWith(".enc");
const isAudio = (p) => p.endsWith(".mp3.enc");
const isIssue = (p) => isEnc(p) && !isAudio(p) && !/\/(index|watchlist)\.enc$/.test(p);

// Drops the oldest entries beyond each limit. Entries are re-inserted on every
// fetch, so keys() order is least-recently-fetched first.
async function trimDataCache(cache) {
  const keys = await cache.keys();
  for (const [matches, max] of [[isAudio, MAX_AUDIO_ENTRIES], [isIssue, MAX_ISSUE_ENTRIES]]) {
    const hits = keys.filter((k) => matches(new URL(k.url).pathname));
    const excess = hits.slice(0, Math.max(0, hits.length - max));
    await Promise.all(excess.map((k) => cache.delete(k)));
  }
}

async function putData(key, res) {
  const cache = await caches.open(DATA_CACHE);
  await cache.delete(key);
  await cache.put(key, res);
  await trimDataCache(cache);
}

// One-time move of encrypted data out of old single-cache versions (<= v2.6).
async function migrateOldCaches(oldNames) {
  const data = await caches.open(DATA_CACHE);
  for (const name of oldNames) {
    const old = await caches.open(name);
    for (const req of await old.keys()) {
      if (!isEnc(new URL(req.url).pathname) || (await data.match(req))) continue;
      const res = await old.match(req);
      if (res) await data.put(req, res);
    }
  }
  await trimDataCache(data);
}

// If any shell asset fails to download, install fails and the current version keeps
// running (with its caches) instead of activating a half-cached update.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Only caches this app created; other apps on the same github.io origin share CacheStorage.
const OWN_CACHE_PREFIX = "world-brief-";

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const old = (await caches.keys()).filter(
        (k) => k.startsWith(OWN_CACHE_PREFIX) && k !== SHELL_CACHE && k !== DATA_CACHE
      );
      try {
        await migrateOldCaches(old);
      } catch {}
      await Promise.all(old.map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Normalize cache key for encrypted data files (strip ?t=... cache-buster)
  const encData = isEnc(url.pathname);
  const cacheKey = encData ? new Request(url.origin + url.pathname) : req;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          const store = encData
            ? putData(cacheKey, clone)
            : caches.open(SHELL_CACHE).then((cache) => cache.put(cacheKey, clone));
          event.waitUntil(store.catch(() => {}));
        }
        return res;
      })
      .catch(() => caches.match(cacheKey))
  );
});
