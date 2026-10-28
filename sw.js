const CACHE_NAME = "calendario-v38";
// Lo esencial para abrir la app sin conexión: si no se puede guardar, la instalación falla
// y se sigue usando la versión anterior con su caché (así nunca queda una app vacía).
const CORE = ["./index.html", "./firebase-bundle.js"];
const EXTRA = ["./", "./manifest.json", "./icon-192.png", "./icon-512.png"];
const NETWORK_TIMEOUT = 1500; // con mala señal, se usa lo guardado en vez de esperar

const OFFLINE_PAGE = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Together</title>" +
  "<body style='background:#06080A;color:#F0F6FC;font-family:sans-serif;padding:40px 28px;line-height:1.5'><h2>Together</h2>" +
  "<p>Sin conexión, y la app todavía no se guardó en este dispositivo.</p><p>Ábrela una vez con Internet y después funcionará sin conexión.</p>";

// Solo se guarda lo que de verdad sirve: un JS que no es JS (p. ej. la página de un wifi con login)
// guardado por error dejaría la app sin poder iniciar hasta borrar la caché.
function validCdn(res, url) {
  if (!res) return false;
  if (res.type === "opaque") return true;
  if (!res.ok) return false;
  if (url.pathname.endsWith(".js")) {
    return /javascript|ecmascript/i.test(res.headers.get("content-type") || "");
  }
  return true;
}

const fresh = (u) => new Request(u, { cache: "reload" });

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(CORE.map((u) => cache.add(fresh(u))));
    await Promise.all(EXTRA.map((u) => cache.add(fresh(u)).catch(() => {})));
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Las cachés anteriores solo se borran si la nueva ya tiene la app completa
    if (await cache.match("./index.html", { ignoreVary: true })) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "SKIP_WAITING") self.skipWaiting();
  if (type === "ENSURE_CACHE") {
    // La app, estando con conexión, pide completar lo que falte en la caché
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      for (const u of CORE.concat(EXTRA)) {
        if (!(await cache.match(u, { ignoreVary: true }))) await cache.add(fresh(u)).catch(() => {});
      }
    })());
  }
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
  if (cached) await cache.delete(req, { ignoreVary: true });
  const res = await fetch(req);
  if (validCdn(res, url)) cache.put(req, res.clone());
  return res;
}

// "no-cache": siempre pregunta al servidor si hay versión nueva
function freshRequest(req) {
  try {
    if (req.mode === "navigate") return new Request(req.url, { cache: "no-cache", credentials: "same-origin" });
    return new Request(req, { cache: "no-cache" });
  } catch (e) {
    return req;
  }
}

// Una respuesta con redirecciones no se puede entregar a una navegación (da ERR_FAILED)
async function clean(res, req) {
  if (res && res.redirected && req.mode === "navigate") {
    return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  return res;
}

async function findCached(cache, req, nav) {
  const opts = { ignoreSearch: nav, ignoreVary: true };
  return (await cache.match(req, opts)) || (await caches.match(req, opts));
}

async function appHandler(req) {
  const cache = await caches.open(CACHE_NAME);
  const nav = req.mode === "navigate";
  const net = fetch(freshRequest(req)).then((res) => {
    const type = res && res.headers ? (res.headers.get("content-type") || "") : "";
    const okToCache = res && res.status === 200 && (!nav || /text\/html/i.test(type));
    if (okToCache) cache.put(req, res.clone());
    return res;
  });
  net.catch(() => {});
  const first = await Promise.race([
    net.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT))
  ]);
  if (first) return clean(first, req);

  const cached = await findCached(cache, req, nav);
  if (cached) return clean(cached, req);
  if (nav) {
    const shell = (await cache.match("./index.html", { ignoreVary: true })) || (await caches.match("./index.html", { ignoreVary: true }));
    if (shell) return clean(shell, req);
  }
  try {
    return await net; // sin copia guardada: esperar a la red
  } catch (e) {
    if (nav) return new Response(OFFLINE_PAGE, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
    return Response.error();
  }
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
