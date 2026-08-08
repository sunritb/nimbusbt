// NimbusBT — service worker: offline cache for app shell.
const CACHE = 'nimbusbt-v1'
const ASSETS = ['/', '/css/style.css', '/js/api.js', '/js/app.js', '/manifest.webmanifest', '/icons/icon.svg']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api') || url.pathname === '/ws') return
  e.respondWith(
    caches.match(e.request).then(hit => {
      const fetched = fetch(e.request)
        .then(res => {
          if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
            const copy = res.clone()
            caches.open(CACHE).then(c => c.put(e.request, copy))
          }
          return res
        })
        .catch(() => caches.match(e.request))
      return hit || fetched
    })
  )
})
