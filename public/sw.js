/* 스마트 대국 — 서비스워커
   실시간 멀티플레이이므로 HTML은 항상 network-first.
   Socket.IO 요청은 서비스워커를 통과시키지 않는다. */
const CACHE = 'smart-daeguk-v8';
const ASSETS = ['/', '/login.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

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
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Socket.IO, API, auth 요청은 네트워크 직통
  if (url.pathname.startsWith('/socket.io') ||
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/sgf/')) return;

  // HTML 페이지: network-first (항상 최신 상태 유지)
  const isHTML = e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/';
  if (isHTML) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match('/login.html')))
    );
    return;
  }

  // 정적 파일(아이콘 등): cache-first
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      }
      return res;
    }))
  );
});