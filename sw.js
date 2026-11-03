// Guarda os arquivos do app para abrir rápido e funcionar como app instalado.
// Os dados (Supabase) sempre vêm da internet, nunca do cache.
const VERSAO = "nc-v11";
const ARQUIVOS = ["./", "index.html", "style.css", "app.js", "config.js", "extrato.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // rede primeiro, cache se estiver sem internet
  e.respondWith(
    fetch(e.request, { cache: "no-store" }).then((r) => { const cp = r.clone(); caches.open(VERSAO).then((c) => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
