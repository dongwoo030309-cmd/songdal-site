/* 아이폰 방문표 오프라인 대비.
   - 화면 파일(html/js/css)은 인터넷이 되면 새로 받고(3초 안에), 안 되면 저장본
   - plan.enc.txt(암호화된 방문표)는 인터넷이 되면 새로 받고, 안 되면 마지막으로 받은 것을 씀 */
const CACHE = "songdal-v2";
const SHELL = ["./", "index.html", "app.js", "map.js", "style.css", "config.js", "manifest.json", "icon-180.png", "icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function planKey() { return new Request(new URL("plan.enc.txt", self.registration.scope).href); }

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // 지도·타일 등 바깥 주소는 그대로
  if (url.pathname.endsWith("/plan.enc.txt")) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req, { cache: "no-store" });
        if (res.ok) await cache.put(planKey(), res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match(planKey());
        if (!hit) throw err;
        const body = await hit.text();
        return new Response(body, { status: 200, headers: { "Content-Type": "text/plain", "X-Songdal-Offline": "1" } });
      }
    })());
    return;
  }
  // 화면 파일: 인터넷 먼저(3초), 안 되면 저장본
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([fetch(req, { cache: "no-cache" }), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))]);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      return hit || new Response("오프라인", { status: 503 });
    }
  })());
});
