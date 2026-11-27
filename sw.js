
/* ============================================================
   MANA PWA — SERVICE WORKER v6
   Offline support + Precache + Runtime cache + Fallback
   GitHub Pages compatible: /MANA/ or /
   ============================================================ */

/* 1. CONFIGURATION */
const CACHE_PREFIX = "mana-pwa-";
const CACHE_VERSION = "v6";
const SHELL_CACHE = `${CACHE_PREFIX}${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_PREFIX}${CACHE_VERSION}-runtime`;

const BASE_URL = new URL(self.registration.scope);
const BASE_PATH = BASE_URL.pathname.endsWith("/") ? BASE_URL.pathname : `${BASE_URL.pathname}/`;
const INDEX_URL = new URL("index.html", BASE_URL).href;
const APP_URL = BASE_URL.href;
const MAX_RUNTIME_CACHE_ITEMS = 250;

const PRECACHE_ASSETS = [
  // "manifest.json",
  // "icons/icon-192.png",
  // "icons/icon-512.png",
];

const CACHEABLE_DESTINATIONS = new Set(["script", "style", "image", "font", "worker", "sharedworker"]);

/* 2. URL HELPERS */
function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isInsideAppScope(url) {
  return isSameOrigin(url) && url.pathname.startsWith(BASE_PATH);
}

function isExcludedPath(url) {
  return url.pathname.includes("/api/") || url.pathname.includes("/auth/") || url.pathname.includes("/oauth/");
}

function isCacheableResponse(response) {
  return Boolean(response && response.status === 200 && (response.type === "basic" || response.type === "default"));
}

function isCacheableRequest(request) {
  if (!request || request.method !== "GET") return false;
  const url = new URL(request.url);
  return isInsideAppScope(url) && !isExcludedPath(url);
}

/* 3. HTML ASSET DISCOVERY */
function getAttribute(tag, attribute) {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? match[1] : null;
}

function extractAssetsFromHTML(html) {
  const assets = new Map();
  const tagRegex = /<(script|link)\b[^>]*>/gi;
  let match;

  while ((match = tagRegex.exec(html)) !== null) {
    const tag = match[0];
    const tagName = match[1].toLowerCase();
    let assetPath = null;
    let essential = false;

    if (tagName === "script") {
      assetPath = getAttribute(tag, "src");
      essential = Boolean(assetPath);
    }

    if (tagName === "link") {
      const href = getAttribute(tag, "href");
      const rel = (getAttribute(tag, "rel") || "").toLowerCase();
      const as = (getAttribute(tag, "as") || "").toLowerCase();

      if (href && (rel.includes("stylesheet") || rel.includes("modulepreload") || rel.includes("preload") || rel.includes("icon") || rel.includes("manifest"))) {
        assetPath = href;
        essential = rel.includes("stylesheet") || rel.includes("modulepreload") || (rel.includes("preload") && as === "script");
      }
    }

    if (!assetPath) continue;

    try {
      const assetURL = new URL(assetPath, INDEX_URL);

      if (isInsideAppScope(assetURL) && !isExcludedPath(assetURL)) {
        const previous = assets.get(assetURL.href);
        assets.set(assetURL.href, {
          url: assetURL.href,
          essential: essential || Boolean(previous && previous.essential),
        });
      }
    } catch (error) {
      console.warn("[MANA PWA] URL asset invalide:", assetPath);
    }
  }

  return Array.from(assets.values());
}

/* 4. CACHE FILE */
async function fetchAndCache(cache, url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "reload",
      credentials: "same-origin",
    });

    if (!isCacheableResponse(response)) return { ok: false, url, status: response.status };

    await cache.put(url, response.clone());
    return { ok: true, url };
  } catch (error) {
    console.warn("[MANA PWA] Impossible de precacher:", url);
    return { ok: false, url, error };
  }
}

/* 5. PRECACHE APPLICATION */
async function precacheApplication() {
  const shellCache = await caches.open(SHELL_CACHE);
  let indexResponse;

  try {
    indexResponse = await fetch(INDEX_URL, {
      method: "GET",
      cache: "reload",
      credentials: "same-origin",
    });
  } catch (error) {
    throw new Error("[MANA PWA] Tsy azo alaina ny index.html.");
  }

  if (!isCacheableResponse(indexResponse)) {
    throw new Error(`[MANA PWA] Index HTML tsy hita: ${indexResponse.status}`);
  }

  const html = await indexResponse.clone().text();

  await shellCache.put(INDEX_URL, indexResponse.clone());
  await shellCache.put(APP_URL, indexResponse.clone());

  const discoveredAssets = extractAssetsFromHTML(html);
  const manualAssets = PRECACHE_ASSETS.map((asset) => ({
    url: new URL(asset, BASE_URL).href,
    essential: false,
  }));

  const assetMap = new Map();

  for (const asset of [...discoveredAssets, ...manualAssets]) {
    const previous = assetMap.get(asset.url);
    assetMap.set(asset.url, {
      url: asset.url,
      essential: asset.essential || Boolean(previous && previous.essential),
    });
  }

  const allAssets = Array.from(assetMap.values());
  const results = await Promise.all(allAssets.map((asset) => fetchAndCache(shellCache, asset.url)));

  const failedEssential = results.filter((result) => {
    if (result.ok) return false;
    const asset = assetMap.get(result.url);
    return asset && asset.essential;
  });

  if (failedEssential.length > 0) {
    throw new Error("[MANA PWA] Tsy voatahiry ireo fichiers essentiels: " + failedEssential.map((item) => item.url).join(", "));
  }

  const failedOptional = results.filter((result) => !result.ok);

  if (failedOptional.length > 0) {
    console.warn("[MANA PWA] Assets optionnels tsy voatahiry:", failedOptional.map((item) => item.url));
  }

  console.info("[MANA PWA] Precache terminé:", results.filter((item) => item.ok).length, "/", allAssets.length, "assets");
}

/* 6. INSTALL EVENT */
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    await precacheApplication();
    await self.skipWaiting();
    console.info("[MANA PWA] Service Worker installé:", CACHE_VERSION);
  })());
});

/* 7. ACTIVATE EVENT */
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();

    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE && name !== RUNTIME_CACHE)
        .map((name) => caches.delete(name))
    );

    await self.clients.claim();
    console.info("[MANA PWA] Service Worker activé:", CACHE_VERSION);
  })());
});

/* 8. NAVIGATION STRATEGY — NETWORK FIRST + OFFLINE FALLBACK */
async function handleNavigation(request) {
  try {
    const response = await fetch(request);

    if (isCacheableResponse(response)) {
      const shellCache = await caches.open(SHELL_CACHE);
      await shellCache.put(INDEX_URL, response.clone());
      await shellCache.put(APP_URL, response.clone());
    }

    return response;
  } catch (error) {
    const shellCache = await caches.open(SHELL_CACHE);
    const cachedIndex = await shellCache.match(INDEX_URL);

    if (cachedIndex) return cachedIndex;

    const cachedApp = await shellCache.match(APP_URL);
    if (cachedApp) return cachedApp;

    return new Response(`<!DOCTYPE html>
<html lang="mg">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#4F46E5">
<title>MANA - Offline</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0f172a;color:white;font-family:Arial,sans-serif;text-align:center}
main{max-width:420px}
p{color:#cbd5e1;line-height:1.6}
button{margin-top:20px;padding:13px 24px;border:0;border-radius:10px;background:#4f46e5;color:white;font-weight:bold;cursor:pointer}
</style>
</head>
<body>
<main>
<h1>MANA</h1>
<p>Tsy misy connexion Internet ary mbola tsy misy application voatahiry.</p>
<p>Midira amin'ny Internet, sokafy ny MANA, ary andraso ho vita ny cache.</p>
<button onclick="location.reload()">Andramo indray</button>
</main>
</body>
</html>`, {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
}

/* 9. STATIC FILE STRATEGY — SHELL FIRST + RUNTIME + NETWORK */
async function handleStaticFile(request) {
  const shellCache = await caches.open(SHELL_CACHE);
  const runtimeCache = await caches.open(RUNTIME_CACHE);

  const shellHit = await shellCache.match(request);
  if (shellHit) return shellHit;

  const runtimeHit = await runtimeCache.match(request);
  if (runtimeHit) return runtimeHit;

  try {
    const response = await fetch(request);

    if (isCacheableResponse(response)) {
      await runtimeCache.put(request, response.clone());
      await trimRuntimeCache();
    }

    return response;
  } catch (error) {
    return new Response("MANA: Fichier indisponible hors connexion.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

/* 10. RUNTIME CACHE CLEANUP */
async function trimRuntimeCache() {
  const cache = await caches.open(RUNTIME_CACHE);
  const keys = await cache.keys();

  if (keys.length <= MAX_RUNTIME_CACHE_ITEMS) return;

  const excess = keys.length - MAX_RUNTIME_CACHE_ITEMS;
  await Promise.all(keys.slice(0, excess).map((request) => cache.delete(request)));
}

/* 11. RUNTIME RESOURCE STRATEGY */
async function handleRuntimeResource(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  if (cached) return cached;

  try {
    const response = await fetch(request);

    if (isCacheableResponse(response)) {
      await cache.put(request, response.clone());
      await trimRuntimeCache();
    }

    return response;
  } catch (error) {
    return Response.error();
  }
}

/* 12. FETCH EVENT */
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const requestURL = new URL(request.url);
  if (!isInsideAppScope(requestURL)) return;
  if (isExcludedPath(requestURL)) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (CACHEABLE_DESTINATIONS.has(request.destination)) {
    event.respondWith(handleStaticFile(request));
    return;
  }

  if (isCacheableRequest(request)) {
    event.respondWith(handleRuntimeResource(request));
  }
});

/* 13. MESSAGE EVENT */
self.addEventListener("message", (event) => {
  const message = event.data;

  if (message === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (message === "CLEAR_MANA_CACHE") {
    event.waitUntil((async () => {
      const cacheNames = await caches.keys();

      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith(CACHE_PREFIX))
          .map((name) => caches.delete(name))
      );

      console.info("[MANA PWA] Cache MANA supprimé.");
    })());
  }
});

/* 14. SERVICE WORKER READY */
console.info("[MANA PWA] Service Worker chargé:", CACHE_VERSION);
