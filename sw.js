const CACHE='vanta-chess-v2';
const SHELL=[
  './',
  './index.html',
  './manifest.webmanifest',
  './src/styles.css',
  './src/board-refresh.css',
  './src/main.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;

  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const cached=await cache.match(request);
    const network=fetch(request).then(response=>{
      if(response&&response.ok)cache.put(request,response.clone());
      return response;
    }).catch(()=>null);

    if(cached){
      event.waitUntil(network);
      return cached;
    }

    const response=await network;
    if(response)return response;
    if(request.mode==='navigate')return cache.match('./index.html');
    return new Response('Offline',{status:503,statusText:'Offline'});
  })());
});
