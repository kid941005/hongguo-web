/* 红果短剧网页版 Service Worker
 *
 * 策略：所有同源静态资源（HTML / JS / CSS / 图标 / vendor）一律「网络优先」，
 *      缓存只作为离线与弱网兜底。资源新鲜度不依赖任何人工维护的版本号：
 *      每次打开都先回源，所以发布新版本后第一屏就是最新界面。
 *
 * CACHE_REV 只决定缓存目录名，用于在「缓存结构」发生变化时一次性清掉旧目录；
 * 它不影响资源是否最新，因此发布新版本时不需要改它。
 */
const CACHE_REV = 'v2';
const STATIC_CACHE = 'hg-static-' + CACHE_REV;
const PRECACHE = [
  '/', '/index.html', '/style.css', '/app.js',
  '/vendor/hls.light.min.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => null))),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      // 只清本应用的旧缓存目录：同源下可能还有别的站点/应用缓存，不能整库删除。
      Promise.all(
        keys.filter((k) => k !== STATIC_CACHE && k.indexOf('hg-static-') === 0)
          .map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

// 网络优先：拿到网络响应就先回给页面，再把最新字节写回缓存；
// 只有网络失败（离线 / 弱网 / DNS 故障）才回落缓存。cacheKey 用于把导航请求统一存成 /index.html。
async function networkFirst(event, req, cacheKey) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.status === 200 && res.type === 'basic') {
      // 不 await：页面先拿到响应；waitUntil 保证写缓存期间 SW 不会被提前回收。
      // 但 waitUntil 只在事件仍可延长时有效，个别浏览器在 await 之后调用会抛
      // InvalidStateError；必须吞掉，否则会被外层 catch 误判成网络失败而回落到旧缓存。
      try {
        event.waitUntil(cache.put(cacheKey || req, res.clone()).catch(() => {}));
      } catch (ignored) { /* 事件已结束：本次响应仍是新的，只是没写回缓存 */ }
    }
    return res;
  } catch (error) {
    const hit = (await cache.match(cacheKey || req)) || (await caches.match(cacheKey || req));
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 接口与媒体流一律走网络，绝不缓存
  if (url.pathname.indexOf('/api/') === 0) return;

  // 页面导航：网络优先，离线回落到缓存的 index.html
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(event, req, '/index.html'));
    return;
  }

  // 其余静态资源同样是网络优先（旧实现是「缓存优先」，发布后第一屏会拿到旧 app.js/style.css）
  event.respondWith(networkFirst(event, req));
});
