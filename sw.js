/* DeepSeek 助手 PWA service worker：静态资源缓存优先，API 请求直接放行。 */
const CACHE = 'ds-chat-v1';
const SHELL = [
  './',
  'index.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      // 预缓存主包与样式，其它异步块用到时再缓存
      const html = await (await fetch('index.html', { cache: 'no-cache' })).text();
      const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
      await Promise.all(
        assets.map((url) => cache.add(url).catch(() => undefined))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 只接管本站资源；API 与第三方一律走网络，不做缓存也不改写
  if (url.origin !== self.location.origin) return;
  if (request.method !== 'GET') return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) {
        // 后台更新，失败不影响返回缓存
        event.waitUntil(
          fetch(request)
            .then((response) => (response.ok ? cache.put(request, response.clone()) : undefined))
            .catch(() => undefined)
        );
        return cached;
      }
      try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch (error) {
        // 导航请求离线时回落到缓存的首页
        if (request.mode === 'navigate') {
          const shell = await cache.match('index.html', { ignoreSearch: true });
          if (shell) return shell;
        }
        throw error;
      }
    })()
  );
});
