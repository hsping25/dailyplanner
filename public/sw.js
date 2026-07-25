// 서비스워커: 홈 화면 설치를 가능하게 하고, 오프라인일 때 앱 껍데기를 보여준다.
// 주의: 일정/할 일 데이터(/api/*)는 절대 캐시하지 않는다 — 항상 최신이어야 하므로.
const CACHE = "planner-v5"; // 버전을 올리면 설치된 폰에서도 옛 캐시가 교체됨
const SHELL = ["/", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // API는 항상 네트워크에서 (캐시 안 함)
  if (url.pathname.startsWith("/api/")) return;

  // 페이지 이동: 네트워크 우선, 실패 시 캐시된 앱 껍데기
  if (request.mode === "navigate") {
    e.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }

  // 정적 자원: 캐시 우선, 없으면 네트워크 후 캐시에 저장
  e.respondWith(
    caches.match(request).then((hit) =>
      hit || fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
        return res;
      })
    )
  );
});
