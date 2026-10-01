/* The collection lives in IndexedDB. This cache stores public app files only. */
"use strict";

importScripts("/share-inbox.js");
const VERSION = "2026-10-01-v7-processing";
const PREFIX = "webweave-nook-";
const SHELL_CACHE = `${PREFIX}shell-${VERSION}`;
const OCR_CACHE = `${PREFIX}ocr-2026-10-01-v3`;
const BASE = new URL("./", self.location.href);
const fileUrl = (name) => new URL(name, BASE).href;
const CORE_FILES = [
  "index.html",
  "styles.css",
  "model.js",
  "capture-tools.js",
  "processing-client.js",
  "sync-model.js",
  "sync-client.js",
  "share-inbox.js",
  "manifest.webmanifest",
  "icons/nook-192.png",
  "icons/nook-512.png",
  "icons/nook-maskable-512.png",
  "icons/nook-180.png",
  "app.js",
  "vendor/tesseract.min.js",
];
const SHELL_URLS = new Set(CORE_FILES.map(fileUrl));
const INDEX_URL = fileUrl("index.html");
const VENDOR_PATH = new URL("vendor/", BASE).pathname;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // A partial app must not replace a working offline installation.
      await cache.addAll(
        CORE_FILES.map((name) => new Request(fileUrl(name), { cache: "reload" })),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith(PREFIX) &&
              name !== SHELL_CACHE &&
              name !== OCR_CACHE,
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

function cacheable(response) {
  return response.ok && response.type !== "opaque";
}

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    // HTTP cache revalidation also matters when the worker version is unchanged.
    const response = await fetch(new Request(request, { cache: "no-cache" }));
    if (cacheable(response)) {
      try {
        await cache.put(cacheKey, response.clone());
      } catch {
        // A full cache should never prevent an online device from opening Nook.
      }
    } else if (response.status >= 500) {
      const saved = await cache.match(cacheKey);
      if (saved) return saved;
    }
    return response;
  } catch (error) {
    const saved = await cache.match(cacheKey);
    if (saved) return saved;
    throw error;
  }
}

async function cachedOcr(request, cacheKey) {
  const cache = await caches.open(OCR_CACHE);
  const saved = await cache.match(cacheKey);
  if (saved) return saved;
  const response = await fetch(request);
  if (cacheable(response)) {
    try {
      await cache.put(cacheKey, response.clone());
    } catch {
      // Recognition can still run if optional offline storage is unavailable.
    }
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method === "POST" && url.origin === BASE.origin && url.pathname === "/share-target") {
    event.respondWith((async () => {
      try {
        const share = NookShares.fromForm(await request.formData(), crypto.randomUUID());
        await NookShares.put(share);
        return Response.redirect(new URL("/?shared=1", BASE).href, 303);
      } catch (error) {
        const message = String(error.message || "Could not save this share. Try again.").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
        return new Response(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Share to Nook</title><body style="font:18px system-ui;background:#fbf7f2;padding:2rem"><h1>This piece needs another try.</h1><p>${message}</p><p><a href="/">Open Nook</a></p></body></html>`, {status: 400, headers: {"Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store"}});
      }
    })());
    return;
  }
  if (
    request.method !== "GET" ||
    url.origin !== BASE.origin ||
    request.headers.has("range") ||
    /\/api(?:\/|$)/.test(url.pathname)
  )
    return;

  // Strip only the query from known static files, never from API or user data.
  const cacheKey = `${url.origin}${url.pathname}`;
  if (
    request.mode === "navigate" &&
    (url.pathname === BASE.pathname || cacheKey === INDEX_URL)
  ) {
    event.respondWith(networkFirst(request, INDEX_URL));
    return;
  }
  if (SHELL_URLS.has(cacheKey)) {
    event.respondWith(networkFirst(request, cacheKey));
    return;
  }
  if (
    url.pathname.startsWith(VENDOR_PATH) &&
    /\.(?:js|wasm|traineddata(?:\.gz)?)$/.test(url.pathname)
  ) {
    // The large recognition engine and language files are downloaded on first use.
    event.respondWith(cachedOcr(request, cacheKey));
  }
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "NOOK_CACHE_VERSION") {
    event.source?.postMessage({ type: "NOOK_CACHE_VERSION", version: VERSION });
  }
});
