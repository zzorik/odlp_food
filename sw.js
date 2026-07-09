// Завхоз · Ладога — service worker. Бампни версию при обновлении файлов.
const CACHE = 'zavhoz-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './raskladka.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // POST к Worker/OpenRouter — мимо кэша
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;       // внешние запросы не трогаем

  // cache-first для своих ассетов, сеть как обновление
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
      return res;
    }).catch(() => hit))
  );
});
