const shell = "dock-outbox-shell-v1";
const paths = ["/", "/desk.css", "/desk.js", "/outbox.js"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(shell).then(cache => cache.addAll(paths)));
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("dock-outbox-shell-") && key !== shell) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || !paths.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(shell);
    return await cache.match(url.pathname) || fetch(event.request);
  })());
});
