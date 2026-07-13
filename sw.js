/* Service Worker — دلّني AI
   ملاحظة مهمة: يجب تغيير رقم APP_VERSION هنا مع كل تحديث حقيقي للملفات،
   وإلا فلن يكتشف المتصفح وجود نسخة جديدة، وستبقى النسخة القديمة معروضة
   للمستخدمين رغم نجاح الرفع على GitHub وVercel. */

const APP_VERSION = "v0.5.0";
const CACHE_NAME = `dallini-cache-${APP_VERSION}`;

const FILES_TO_CACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* استراتيجية "الشبكة أولًا": نحاول جلب أحدث نسخة من الإنترنت دائمًا،
   ولا نلجأ للنسخة المحفوظة إلا إذا تعذّر الاتصال فعليًا (وضع عدم الاتصال). */
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
