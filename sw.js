// Offline shell. A club hall often has no usable signal, and the app needs
// nothing from the network once it is loaded — the camera and microphone are
// local. Cache-first, with a background refresh so updates still land.

const CACHE = 'umpire-v2';
const SHELL = [
  './', './index.html', './css/styles.css',
  './js/main.js', './js/vision.js', './js/audio.js',
  './js/detector.js', './js/onset-processor.js', './js/referee.js', './js/rules.js',
  './js/sync.js',
  './js/vendor/pako.min.js', './js/vendor/qrcode.min.js', './js/vendor/jsQR.min.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => {
      const live = fetch(e.request)
        .then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || live;
    })
  );
});
