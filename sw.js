/* Service Worker — دلّني AI
   ملاحظة مهمة: يجب تغيير رقم APP_VERSION هنا مع كل تحديث حقيقي للملفات،
   وإلا فلن يكتشف المتصفح وجود نسخة جديدة، وستبقى النسخة القديمة معروضة
   للمستخدمين رغم نجاح الرفع على GitHub وVercel. */

const APP_VERSION = "v1.0.0";
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
   ولا نلجأ للنسخة المحفوظة إلا إذا تعذّر الاتصال فعليًا (وضع عدم الاتصال).

   ملاحظات استقرار مضافة في هذه المراجعة:
   1) نتجاهل تمامًا أي طلب ليس GET (مثل POST)، فالشبكة/الكاش لا يصلحان لها،
      وترك المتصفح يتعامل معها مباشرة أكثر أمانًا.
   2) نتعامل بحذر مع طلبات النطاقات الخارجية (كالخطوط) دون كسر الصفحة
      إن فشل تخزينها مؤقتًا.
   3) عند تعذّر الشبكة وعدم وجود نسخة مخزنة لصفحة تنقّل (تصفح مباشر لرابط
      الموقع)، نعيد صفحة index.html المخزنة بدل ترك المتصفح يعرض خطأ فارغ. */
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // تجاهل أي طلب ليس GET (POST/PUT/...) تمامًا؛ لا تخزين ولا اعتراض.
  if (req.method !== "GET") return;

  event.respondWith(
    fetch(req)
      .then((response) => {
        // لا نخزّن الردود غير الصالحة (مثل 404) لتفادي حفظ أخطاء كصفحات دائمة.
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(req, clone).catch(() => { /* تجاهل فشل التخزين بصمت */ });
          });
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        // طلب تنقّل (فتح صفحة) بدون إنترنت وبدون نسخة مخزنة له تحديدًا:
        // أعد الصفحة الرئيسية المخزنة بدل ترك المتصفح يعرض خطأ شبكة فارغ.
        if (req.mode === "navigate") {
          const fallback = await caches.match("./index.html");
          if (fallback) return fallback;
        }
        return Response.error();
      })
  );
});
