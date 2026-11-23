// Service worker of wuica: makes the page work offline after the first visit.
// Everything is served cache-first from a cache named after the build; build.sh stamps VERSION (a hash of the
// site's files), so a new deploy is a new worker with a new, empty cache, and the old cache is deleted.
//   install:   the page itself, the analyzer and uarch.json are fetched into the cache (the list is manifest.json)
//   fetch:     cache first; what is not cached yet (instruction tables, the assembler) is fetched and added
const VERSION = '__WUICA_VERSION__';
const CACHE = `wuica-${VERSION}`;
const LAZY = /^(data\/arch\/|wuica_asm\.wasm$)/; // large, fetched when needed (the page prefetches the tables)

const scope = new URL(self.registration.scope);

// The host redirects /index.html to / (and /404.html to /404). A redirected response must never be cached or served
// for a navigation: the browser rejects it (ERR_FAILED). So the page is fetched as './' and every response that was
// reached through a redirect is stored as a plain copy without the redirect flag.
const fetchPath = (path) => (path === 'index.html' ? './' : path === '404.html' ? '404' : path);
async function plain(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}
const relative = (url) => (url.origin === scope.origin && url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : null);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const res = await fetch('manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
    const manifest = await res.clone().json();
    if (manifest.version !== VERSION) throw new Error('manifest.json belongs to another build'); // mid-deploy: retry on the next visit
    await cache.put('manifest.json', res);
    await Promise.all(Object.keys(manifest.files).filter((p) => !LAZY.test(p)).map(async (path) => {
      const r = await fetch(fetchPath(path), { cache: 'no-cache' });
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      await cache.put(path, await plain(r));
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('wuica-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  let path = relative(url);
  if (path === null) return; // not ours: the browser handles it
  if (path === '') path = 'index.html'; // the page, with or without a query string
  event.respondWith((async () => {
    const key = new URL(path, scope).href;
    const hit = await caches.match(key, { cacheName: CACHE });
    if (hit && !hit.redirected) return hit; // (a redirected copy from an older worker is never served)
    try {
      const res = await plain(await fetch(req));
      if (res.ok && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        event.waitUntil((async () => {
          // Not caches.open() unconditionally: once a newer worker has deleted this build's cache, a request
          // that this worker still answers must not bring the cache back.
          if (await caches.has(CACHE)) await (await caches.open(CACHE)).put(key, copy);
        })().catch(() => {})); // e.g. over quota: still answer
      }
      return res;
    } catch {
      return Response.error(); // offline and not cached
    }
  })());
});
