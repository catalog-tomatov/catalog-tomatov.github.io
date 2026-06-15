const CACHE_NAME = 'images-v1';

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.destination !== 'image') return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(request);

      if (cached) {
        return cached;
      }

      try {
        const response = await fetch(request);

        cache.put(request, response.clone());

        return response;
      } catch {
        return cached;
      }
    })
  );
});