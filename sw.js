/* お得な支払いガイド — Service Worker
 * アプリ本体: キャッシュ優先（更新時は CACHE のバージョンを上げる）
 * data/*.json: ネットワーク優先 → 失敗したら保存済みデータ（オフライン閲覧）
 */
const CACHE = 'opg-v12';
const SHELL = [
  './', 'index.html', 'css/style.css', 'js/engine.js', 'js/app.js', 'manifest.json',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'data/services.json', 'data/settings.json', 'data/stores.json', 'data/online-shops.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.includes('/data/') && url.pathname.endsWith('.json')) {
    // データ: ネットワーク優先
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname, copy)); }
        return res;
      }).catch(() => caches.match(url.pathname).then((r) => r || caches.match(req, { ignoreSearch: true })))
    );
    return;
  }
  // 本体: キャッシュ優先 + 裏で更新
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit || caches.match('index.html'));
      return hit || net;
    })
  );
});
