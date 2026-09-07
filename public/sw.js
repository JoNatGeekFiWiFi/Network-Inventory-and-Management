// Service worker: make the app open instantly and fail honestly.
//
// Scope is deliberately narrow. This caches the SHELL — the HTML, script, stylesheet and icons —
// so that launching from the home screen does not stare at a white page while LTE negotiates, and
// so that losing signal produces "you're offline" rather than Safari's dinosaur. It does NOT cache
// data. Offline records and a sync outbox are a separate, harder problem, and pretending to have
// solved it by serving a stale site to a tech standing in front of the hardware would be worse
// than admitting there is no signal.
//
// Two rules that must not be relaxed:
//   1. Nothing under /api is ever written to the cache. Those responses are per-user and some are
//      audited; a cached copy on a shared or lost device is a liability with no upside here.
//   2. Only GET is ever cached. A cached POST would be a replayed write.

const VERSION = 'v2';
const SHELL_CACHE = `netinv-shell-${VERSION}`;
const ASSET_CACHE = `netinv-assets-${VERSION}`;

// The minimum needed to render something useful. Kept short on purpose: a long precache list makes
// installs slow and fail atomically, and everything else is picked up as it is used.
const SHELL = [
  '/',
  '/app.js',
  '/styles.css',
  '/barcode.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll fails the whole install if any single entry 404s. Add individually so one missing
    // icon cannot leave the app permanently uninstallable.
    await Promise.all(SHELL.map(url => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Let the page ask for an immediate takeover after it has told the user an update is ready.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

const isApi = url => url.pathname.startsWith('/api/');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // never touch writes

  const url = new URL(req.url);

  // API traffic goes straight to the network, always. No cache read, no cache write.
  if (isApi(url)) return;

  // Navigations: network first, so a deploy reaches installed devices on the next launch rather
  // than whenever a cache happens to expire. Falls back to the cached shell only for the SPA —
  // /portal, /access and /locator are separate pages and should show the browser's own error.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        const cached = await caches.match('/', { cacheName: SHELL_CACHE });
        if (cached && (url.pathname === '/' || url.pathname === '/index.html')) return cached;
        return new Response(
          '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
          + '<body style="font:16px -apple-system,sans-serif;padding:2rem;background:#10161d;color:#e6eaf0">'
          + '<h1 style="font-size:1.2rem">No connection</h1>'
          + '<p style="color:#9aa6b2">This page needs a network. It will work again once you have signal.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // Our own code — app.js, barcode.js, styles.css — is network-first with a short timeout.
  //
  // Stale-while-revalidate was the first choice and it is wrong for these: it serves the OLD file
  // and fetches the new one for NEXT time, so every deploy needs two launches before the fix is
  // actually running. That turned a scanner fix into "it still does not work" for no reason. These
  // files are small; wait briefly for the current one, and fall back to cache when there is no
  // signal, which is the case the cache exists for.
  const sameOrigin = url.origin === self.location.origin;
  const cdn = url.hostname === 'cdnjs.cloudflare.com';
  if (!sameOrigin && !cdn) return;

  const isOurCode = sameOrigin && /\.(js|css)$/.test(url.pathname);

  event.respondWith((async () => {
    const cacheName = sameOrigin ? SHELL_CACHE : ASSET_CACHE;
    const cache = await caches.open(cacheName);

    const fromNetwork = fetch(req).then(res => {
      if (res && res.status === 200 && res.type !== 'opaque') cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);

    if (isOurCode) {
      // Race the network against a timer rather than against the cache, so a slow connection
      // degrades to the cached copy instead of hanging.
      const timeout = new Promise(resolve => setTimeout(() => resolve(null), 2500));
      const fresh = await Promise.race([fromNetwork, timeout]);
      if (fresh) return fresh;
      const cached = await cache.match(req);
      if (cached) { event.waitUntil(fromNetwork); return cached; }
      return (await fromNetwork) || new Response('', { status: 504, statusText: 'Offline' });
    }

    // Images, fonts and the CDN libraries: these do not change, so cache-first is right.
    const cached = await cache.match(req);
    if (cached) { event.waitUntil(fromNetwork); return cached; }
    return (await fromNetwork) || new Response('', { status: 504, statusText: 'Offline' });
  })());
});
