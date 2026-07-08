const CLEANUP_CACHE_PREFIXES = ['cactus-v3', 'cactus-v2', 'cactus-v1'];

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => CLEANUP_CACHE_PREFIXES.some(prefix => key.startsWith(prefix)))
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', () => {
  // Keep the old registration harmless. Requests now use the network and normal HTTP cache.
});
