// Завхоз · Ладога — service worker.
// Стратегия: свои html/js/json/css — «сеть вперёд» (онлайн всегда свежее, офлайн из кэша).
// Иконки/манифест — «кэш вперёд». Версию можно не бампать: контент сам обновляется онлайн.
const CACHE = 'zavhoz-v3';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './raskladka.json',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
];
// что тянуть «сеть вперёд» (эти файлы меняются между сборками)
const FRESH = [/\/$/, /index\.html$/, /app\.js$/, /styles\.css$/, /raskladka\.json$/];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // POST к Worker/OpenRouter — мимо кэша
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;       // внешние запросы не трогаем

  const fresh = FRESH.some(re => re.test(url.pathname));
  if (fresh){
    // сеть вперёд: online → свежак и обновляем кэш; offline → из кэша
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
        return res;
      }).catch(() => caches.match(req, {ignoreSearch:true}))
    );
  } else {
    // кэш вперёд для статики (иконки, манифест)
    e.respondWith(
      caches.match(req, {ignoreSearch:true}).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
        return res;
      }))
    );
  }
});
