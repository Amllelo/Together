const CACHE_NAME = "calendario-v27";
const FIREBASE = "https://www.gstatic.com/firebasejs/10.8.0/";
const LOCAL_ASSETS = ["./", "./index.html", "./manifest.json", "./firebase-bundle.js", "./icon-192.png", "./icon-512.png"];
const CDN_ASSETS = [];   // la CDN de Google solo es respaldo: se guarda al usarse
const NETWORK_TIMEOUT = 1500; // con mala señal, se usa lo guardado en vez de esperar

// Solo se guarda lo que de verdad sirve: un JS que no es JS (p. ej. la página de un wifi con login)
// guardado por error dejaría la app sin poder iniciar hasta borrar la caché.
function validCdn(res, url) {
  if (!res) return false;
  if (res.type === "opaque") return true;            // estilos/fuentes sin CORS: no se pueden inspeccionar
  if (!res.ok) return false;
  if (url.pathname.endsWith(".js")) {
    return /javascript|ecmascript/i.test(res.headers.get("content-type") || "");
  }
  return true;
}

self.addEventListener("install", (event) => {
  // Cada recurso por separado: si falta uno (p. ej. un ícono) no se rompe la instalación
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all([
        ...LOCAL_ASSETS.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})),
        ...CDN_ASSETS.map((url) =>
          fetch(new Request(url, { mode: "cors" }))
            .then((res) => { if (validCdn(res, new URL(url))) return cache.put(url, res); })
            .catch(() => {})
        )
      ])
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// Librerías de Firebase (versión fija) y fuentes: se guardan para que la app abra sin conexión
async function cdnHandler(req, revalidate) {
  const cache = await caches.open(CACHE_NAME);
  const url = new URL(req.url);
  const cached = await cache.match(req, { ignoreVary: true });
  if (cached && validCdn(cached, url)) {
    if (revalidate) {
      fetch(req).then((res) => { if (validCdn(res, url)) cache.put(req, res.clone()); }).catch(() => {});
    }
    return cached;
  }
  if (cached) await cache.delete(req, { ignoreVary: true });   // copia inválida: descartarla
  const res = await fetch(req);
  if (validCdn(res, url)) cache.put(req, res.clone());
  return res;
}

// Archivos de la app: red primero (siempre la versión nueva), pero sin esperar de más
// "no-cache": siempre pregunta al servidor si hay versión nueva (GitHub Pages guarda 10 min en la caché HTTP
// y sin esto el teléfono podía seguir con un index.html viejo después de publicar uno nuevo).
function freshRequest(req) {
  try {
    if (req.mode === "navigate") return new Request(req.url, { cache: "no-cache", credentials: "same-origin" });
    return new Request(req, { cache: "no-cache" });
  } catch (e) {
    return req;
  }
}

async function appHandler(req) {
  const cache = await caches.open(CACHE_NAME);
  const net = fetch(freshRequest(req)).then((res) => {
    const type = res && res.headers ? (res.headers.get("content-type") || "") : "";
    const okToCache = res && res.status === 200 && (req.mode !== "navigate" || /text\/html/i.test(type));
    if (okToCache) cache.put(req, res.clone());
    return res;
  });
  net.catch(() => {});
  const first = await Promise.race([
    net.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT))
  ]);
  if (first) return first;

  const cached = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
  if (cached) return cached;
  if (req.mode === "navigate") {
    const shell = await cache.match("./index.html");
    if (shell) return shell;
  }
  return net; // sin copia guardada: esperar a la red
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) {
    event.respondWith(cdnHandler(req, false));
  } else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(cdnHandler(req, true));
  } else if (url.origin === self.location.origin) {
    event.respondWith(appHandler(req));
  }
});
