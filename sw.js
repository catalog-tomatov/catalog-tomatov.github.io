const SHELL_CACHE = "catalog-shell-v101";
const IMAGE_CACHE = "catalog-images-v5";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css?v=59",
  "./script.js?v=72",
  "./chat.js?v=38",
  "./firebase-config.js?v=1",
  "./firebase-client.js?v=7",
  "./manifest.json",
  "./chat-icon.png",
  "./max-icon.png",
  "./vendor/canvas-confetti-1.9.3.min.js",
  "./vendor/html2canvas-1.4.1.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // addAll is deliberately atomic: if an essential shell file is missing,
      // the previous working service worker stays active and its cache is kept.
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (key) =>
                  (key.startsWith("catalog-shell-") && key !== SHELL_CACHE) ||
                  (key.startsWith("catalog-images-") && key !== IMAGE_CACHE) ||
                  key.startsWith("images-"),
              )
              .map((key) => caches.delete(key)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok || response.type === "opaque") {
      await cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    // Недоступная внешняя картинка не должна ронять fetch-обработчик SW и
    // создавать Uncaught (in promise) для каждого изображения в консоли.
    const stale = await cache.match(request,{ignoreSearch:true});
    if (stale) return stale;
    return new Response(null,{status:504,statusText:"Image unavailable"});
  }
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok)
      await cache.put(request, response.clone()).catch(() => undefined);
    return response;
  } catch (error) {
    return (
      (await cache.match(request)) ||
      (await cache.match("./index.html")) ||
      Promise.reject(error)
    );
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // VPN-тест всегда идёт напрямую в сеть,
  // его специально не берём из кэша.
  if (url.searchParams.has("__vpn_test")) {
    return;
  }

  // Картинки кэшируем с ЛЮБОГО домена.
  if (request.destination === "image") {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  // Всё остальное кэшируем только с нашего сайта.
  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
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
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const orderId = String(payload.orderId || "");
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      windows.forEach((client) =>
        client.postMessage({
          type: "catalog-chat-message",
          orderId,
          messageId: String(payload.messageId || ""),
        }),
      );
      // Показываем системное уведомление всегда. На iPhone свёрнутая PWA
      // иногда ещё считается `visible`, из-за чего прежняя проверка
      // ошибочно проглатывала push.
      await self.registration.showNotification(
        payload.title || "Каталог томатов",
        {
          body:
            payload.body ||
            (orderId
              ? `Новое сообщение по заказу ${orderId}`
              : "Новое сообщение продавца"),
          icon: "./tomato/favicon-192.png",
          badge: "./tomato/favicon-192.png",
          tag:
            payload.tag || (orderId ? `order-chat-${orderId}` : "order-chat"),
          renotify: true,
          data: { orderId },
        },
      );
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const orderId = String(event.notification.data?.orderId || "");
  const target = orderId ? `./?chat=${encodeURIComponent(orderId)}` : "./";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windows) => {
        for (const client of windows) {
          if ("navigate" in client) await client.navigate(target);
          return client.focus();
        }
        return self.clients.openWindow(target);
      }),
  );
});
