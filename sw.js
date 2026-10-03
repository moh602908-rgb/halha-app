/* Service Worker — دلّني AI
   ملاحظة مهمة: يجب تغيير رقم APP_VERSION هنا مع كل تحديث حقيقي للملفات،
   وإلا فلن يكتشف المتصفح وجود نسخة جديدة، وستبقى النسخة القديمة معروضة
   للمستخدمين رغم نجاح الرفع على GitHub وVercel. */

const APP_VERSION = "v2.6.0";
const CACHE_NAME = `dallini-cache-${APP_VERSION}`;

const FILES_TO_CACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon.svg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  // Foundation v2: صفحة اليوم وملفات Organizer تُخزَّن عند تثبيت الـ SW (التحميل الأول ← التخزين ← Offline)
  "./today.html",
  "./today-ui.js",
  "./today-add.js",
  "./organizer-db.js",
  "./organizer-model.js",
  "./organizer-schedule.js",
  "./organizer-crud.js",
  "./organizer-recurrence.js",
  "./organizer-editing.js",
  "./organizer-series-split.js",
  "./organizer-series-stop.js",
  "./organizer-postpone.js",
  "./organizer-selection.js",
  "./organizer-today.js",
  // Time System (الحزمة 2): بلا مساس بملفات Foundation أعلاه
  "./time.html",
  "./time-ui.js",
  "./settings.html",
  "./settings-ui.js",
  "./organizer-timedb.js",
  "./organizer-settings.js",
  "./organizer-time.js",
  "./organizer-exporter.js",
  "./organizer-voice.js",
  "./voice-tts-web.js",
  "./organizer-week.js",
  "./organizer-domains.js",
  // الحزمة 3: الرأس الموحَّد وصينية الرنين (بلا أي ملف جديد خارج واجهة Time System)
  "./app-header.js",
  "./ring-tray.js",
  "./alarm-tone.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // نجلب كل ملف يدويًا بـ { cache: "no-store" } بدل caches.addAll() المباشر،
      // لأن addAll() تستخدم داخليًا fetch بوضع الكاش الافتراضي، وقد "تُغذّي"
      // ذاكرة الـ Service Worker بنسخة قديمة موجودة أصلاً في ذاكرة كاش المتصفح.
      await Promise.all(
        FILES_TO_CACHE.map(async (url) => {
          try {
            const response = await fetch(url, { cache: "no-store" });
            if (response && response.ok) await cache.put(url, response);
          } catch (e) { /* تجاهل فشل تخزين ملف واحد دون كسر التثبيت كاملاً */ }
        })
      );
    })
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

   ⚠️ إصلاح جوهري في هذه المراجعة (هذا كان سبب ظهور نسخة قديمة رغم النشر):
   fetch(req) بدون تحديد وضع الكاش يستخدم افتراضيًا وضع "default"، والذي
   يسمح للمتصفح بالإجابة من ذاكرة HTTP Cache الخاصة به دون الاتصال بالشبكة
   فعليًا، حتى داخل الـ Service Worker وحتى في التصفح المتخفي أحيانًا. هذا
   يُبطل استراتيجية "الشبكة أولًا" تمامًا رغم أن الكود يبدو صحيحًا ظاهريًا.
   الحل: استخدام { cache: "no-store" } لإجبار كل طلب يمر عبر هذا الـ Service
   Worker على الاتصال الفعلي بالخادم دائمًا، وتجاهل أي نسخة HTTP مخزنة مسبقًا.

   ملاحظات استقرار إضافية:
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

  // استثناء مسارات لوحة المالك: تمرير مباشر للشبكة دون أي مرور بالـ Cache،
  // لمنع تخزين بيانات Owner Dashboard (حالة النظام، الاستخدام، التنبيهات...).
  if (new URL(req.url).pathname.startsWith("/api/owner-")) {
    event.respondWith(fetch(req, { cache: "no-store" }));
    return;
  }

  event.respondWith(
    fetch(req, { cache: "no-store" })
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
        // ignoreSearch: today.html?x=1 (أو أي رابط بمعاملات) يجب أن يجد النسخة المخزنة عند انقطاع الشبكة.
        const cached = (await caches.match(req)) || (await caches.match(req, { ignoreSearch: true }));
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

// Time System: عرض إشعار نصي فقط عند طلب الصفحة (voice-tts-web.js)، أثناء عملها فقط (message → SW → showNotification).
// لا speechSynthesis هنا إطلاقًا (غير متاحة من SW أصلًا)، ولا Push API (بلا خادم في هذا التطبيق).
// الحزمة 3: لا يُعرض شيء إلا إذا كان إذن الإشعارات granted (حارس ثانٍ بعد حارس الصفحة)، والنص الأساسي عام بلا اسم المستخدم.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "organizer_show_reminder_notification") return;
  if (!self.registration || !self.registration.showNotification) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const body = typeof data.body === "string" && data.body ? data.body : "مرافق دلّني";
  event.waitUntil(
    self.registration.showNotification(data.title || "تذكير", { tag: data.tag, body }).catch(() => {})
  );
});

// نقر الإشعار: يُغلقه ويُظهر نافذة التطبيق المفتوحة أو يفتح صفحة منظومة الوقت (ضمن البنية الحالية، بلا أي منطق بيانات هنا).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) { if (c && typeof c.focus === "function") return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow("./time.html");
    return undefined;
  })());
});
