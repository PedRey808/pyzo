// Минимальный service worker: нужен, чтобы приложение можно было «установить» на телефон.
const SHELL = ["/", "/static/style.css", "/static/app.js", "/static/icon.svg", "/static/manifest.json"];
self.addEventListener("install", (e) => e.waitUntil(caches.open("musichub-v1").then((c) => c.addAll(SHELL))));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
