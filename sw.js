const SHELL_CACHE = "catalog-shell-v76";
const IMAGE_CACHE = "catalog-images-v4";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./chat.js",
  "./manifest.json",
  "./chat-icon.png",
  "./max-icon.png",
  "./vendor/canvas-confetti-1.9.3.min.js",
  "./vendor/html2canvas-1.4.1.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => Promise.allSettled(SHELL_FILES.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(
        keys
          .filter((key) => (
            (key.startsWith("catalog-shell-") && key !== SHELL_CACHE)
            || (key.startsWith("catalog-images-") && key !== IMAGE_CACHE)
            || key.startsWith("images-")
          ))
          .map((key) => caches.delete(key)),
      )),
      self.clients.claim(),
    ]),
  );
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === "opaque") {
    await cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone()).catch(() => undefined);
    return response;
  } catch (error) {
    return (await cache.match(request)) || (await cache.match("./index.html")) || Promise.reject(error);
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  if (request.destination === "image") {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  if (["script", "style", "font", "manifest"].includes(request.destination)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});

/* Push-обработчики не запрашивают разрешение сами. Подписку можно включить
 * отдельной кнопкой после создания внутреннего чата. */
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const orderId = String(payload.orderId || "");
  event.waitUntil(self.registration.showNotification(
    payload.title || "Каталог томатов",
    {
      body: payload.body || (orderId ? `Новое сообщение по заказу ${orderId}` : "Новое сообщение продавца"),
      icon: "./tomato/favicon-192.png",
      badge: "./tomato/favicon-192.png",
      tag: orderId ? `order-chat-${orderId}` : "order-chat",
      data: { orderId },
    },
  ));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const orderId = String(event.notification.data?.orderId || "");
  const target = orderId ? `./?chat=${encodeURIComponent(orderId)}` : "./";
  event.waitUntil(clients.openWindow(target));
});
