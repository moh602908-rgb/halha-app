/* ============================================================
   lib/ratelimit.js — عدّاد استخدام يومي موقّع رقميًا (بدون قاعدة بيانات)
   ============================================================
   الفكرة: نخزّن {date, count} داخل كوكي HttpOnly، لكن موقّعة بتوقيع
   HMAC-SHA256 بمفتاح سرّي لا يعرفه إلا الخادم. أي تعديل يدوي على قيمة
   الكوكي من أدوات المطوّر يُبطل التوقيع فورًا، فيعيد الخادم العدّ من
   صفر تلقائيًا — أي لا فائدة عملية من محاولة التلاعب بالعدد. هذا يوفّر
   حماية حقيقية دون الحاجة لأي قاعدة بيانات أو خدمة خارجية إضافية.

   قابلية النقل: يعتمد فقط على Web Crypto API (crypto.subtle) المتوفرة
   في كل بيئات Edge/Node الحديثة، وليست خاصة بـ Vercel — يعمل بنفس
   الشكل على أي استضافة أخرى تدعم Fetch API القياسي.

   ============================================================
   المرحلة 3 — تقوية الأمان (إضافات على البنية الأصلية أعلاه):
   ============================================================
   1) lastRequestAt: حقل جديد داخل نفس الكوكي الموقّعة (وليس كوكي
      منفصلة)، يُستخدم لمنع إرسال طلبين متتاليين خلال فاصل زمني قصير
      جداً (Throttling) — راجع MIN_REQUEST_INTERVAL_MS في config.js.

   2) العدّاد العام (globalDailyCheck): طبقة دفاع إضافية "Best-effort"
      فقط، مخزّنة في متغيّر ذاكرة عادي (globalThis) — وليست بديلاً عن
      حماية مركزية حقيقية. حدودها المعروفة والمقصودة:
        - غير موزّعة: كل نسخة من الخادم (Vercel Edge instance) لها
          عدّادها الخاص المنفصل، فالسقف الفعلي قد يتضاعف بعدد النسخ
          النشطة في نفس اليوم.
        - غير دائمة: تُصفَّر تلقائياً عند إعادة تشغيل أي نسخة (Cold
          Start)، وليس فقط عند تغيّر التاريخ.
      دراسة حماية مركزية حقيقية (تخزين خارجي مشترك) مسجّلة كمرحلة
      مستقبلية منفصلة، تحتاج قراراً صريحاً بخصوص إدخال تبعية خارجية.
   ============================================================ */

function toBase64Url(bytes) {
  let str = "";
  bytes.forEach(b => { str += String.fromCharCode(b); });
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSign(text, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return toBase64Url(new Uint8Array(sigBuffer));
}

function base64UrlEncode(text) {
  return toBase64Url(new TextEncoder().encode(text));
}
function base64UrlDecode(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return atob(padded);
}

export function todayKeyUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export function readCookie(req, name) {
  const header = req.headers.get("cookie") || "";
  const match = header.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return match ? match[1] : null;
}

export async function signUsageCookie(payloadObj, secret) {
  const payload = base64UrlEncode(JSON.stringify(payloadObj));
  const sig = await hmacSign(payload, secret);
  return `${payload}.${sig}`;
}

export async function verifyUsageCookie(cookieValue, secret) {
  if (!cookieValue || !cookieValue.includes(".")) return null;
  const [payload, sig] = cookieValue.split(".");
  const expectedSig = await hmacSign(payload, secret);
  if (expectedSig !== sig) return null; // توقيع غير صالح (تلاعب أو كوكي تالفة) — نتجاهلها
  try {
    return JSON.parse(base64UrlDecode(payload));
  } catch {
    return null;
  }
}

/**
 * يقرأ العدّاد الحالي لليوم من الطلب، ويتحقق من الحد، ويُرجع دالة
 * commit() لبناء قيمة الكوكي الجديدة فقط بعد نجاح استدعاء الذكاء
 * الاصطناعي فعليًا (حتى لا يُحتسب سؤال فشل الاتصال به من رصيد المستخدم).
 *
 * المرحلة 3: تُضاف أيضاً نتيجة فحص Throttling (throttled: true/false)
 * بناءً على lastRequestAt المخزّن في نفس الكوكي — لا يُستهلك أي رصيد
 * عند throttled === true، تماماً كما لا يُستهلك عند فشل استدعاء الذكاء
 * الاصطناعي.
 */
export async function checkAndPrepareUsage(req, { cookieName, secret, dailyLimit, maxAgeSeconds, minRequestIntervalMs }) {
  const today = todayKeyUTC();
  const now = Date.now();
  const existingCookie = readCookie(req, cookieName);
  const existingUsage = await verifyUsageCookie(existingCookie, secret);
  const currentCount = (existingUsage && existingUsage.date === today && Number.isFinite(existingUsage.count))
    ? existingUsage.count
    : 0;
  const lastRequestAt = (existingUsage && Number.isFinite(existingUsage.lastRequestAt))
    ? existingUsage.lastRequestAt
    : 0;

  const elapsedMs = now - lastRequestAt;
  const throttled = Number.isFinite(minRequestIntervalMs) && minRequestIntervalMs > 0 && elapsedMs < minRequestIntervalMs;
  const retryAfterMs = throttled ? Math.max(0, minRequestIntervalMs - elapsedMs) : 0;

  const allowed = !throttled && currentCount < dailyLimit;
  const remaining = Math.max(0, dailyLimit - currentCount);

  async function commit() {
    const newCount = currentCount + 1;
    const value = await signUsageCookie({ date: today, count: newCount, lastRequestAt: now }, secret);
    return {
      cookieHeader: `${cookieName}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`,
      remaining: Math.max(0, dailyLimit - newCount)
    };
  }

  return { allowed, throttled, retryAfterMs, remaining, currentCount, commit };
}

/* ============================================================
   المرحلة 8 — العدّاد العام الموزّع (Upstash Redis REST)
   ============================================================
   يستبدل هذا القسم التخزين السابق في الذاكرة المحلية (globalThis)،
   الذي كان محدودًا بحدود موثّقة (غير موزّع بين نسخ الخادم، وغير دائم
   عبر إعادة التشغيل). يبقى الغرض من هذا العدّاد كما هو تمامًا: طبقة
   دفاع ثانوية تقديرية (Best-effort) فوق الحماية الأساسية الحقيقية
   (فحص Origin، الحصة الفردية الموقّعة HMAC، Vercel Firewall) — لا
   يستبدلها ولا يغيّر من طبيعتها.

   مبدأ التصميم (Minimum Data Principle):
   المفتاح المخزَّن في Redis هو رقم عدّاد فقط تحت اسم يحمل التاريخ
   (dallini:global_usage:YYYY-MM-DD) — لا يوجد فيه أي IP أو كوكي أو
   معرّف مستخدم أو سؤال أو إجابة أو أي بيانات شخصية من أي نوع. حتى
   في حال اختراق قاعدة بيانات Upstash نفسها، لا يجد المهاجم شيئًا
   أبعد من رقم عدّاد يومي مجهول الهوية بالكامل.

   يُستخدم Upstash REST API مباشرة عبر fetch قياسي، بدون أي حزمة SDK
   إضافية، حفاظًا على خلوّ package.json من تبعيات خارجية غير ضرورية.

   سياسة الفشل (Fail-Open المتحفظ، معتمدة صراحةً من المالك):
   إن تعذّر الاتصال بـ Redis لأي سبب (متغيرات بيئة غير مضبوطة، خطأ
   شبكة، استجابة غير ناجحة)، يُسمح للطلب بالمرور ولا تُعطَّل الخدمة
   عن المستخدمين بسبب فشل مكوّن ثانوي خارجي. يُسجَّل الحدث محليًا في
   سجلات Vercel عبر console.warn فقط — نوع الفشل ورمز/رسالة الخطأ
   المختصرة حصرًا، دون أي IP أو سؤال أو محتوى مستخدم بأي شكل. مراجعة
   تكرار هذه الحالات مؤجّلة إلى مرحلة الفحص الجذري (Root Audit).
   ============================================================ */

const GLOBAL_KEY_PREFIX = "dallini:global_usage:";
// أطول قليلاً من 24 ساعة لتغطية أي فارق بسيط عند حافة التاريخ، وتنظيف
// تلقائي للمفتاح القديم دون أي صيانة يدوية.
const GLOBAL_KEY_TTL_SECONDS = 90000;

function redisConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

/**
 * تسجيل فشل الاتصال بـ Redis فقط — بدون أي بيانات مستخدم إطلاقًا
 * (لا IP، لا Origin، لا سؤال، لا محتوى)، التزامًا بمبدأ الحد الأدنى
 * من البيانات حتى في سجلّات التشخيص الداخلية.
 */
function logRedisFailure(kind, detail) {
  try {
    console.warn("[dallini-security] global_counter_fail_open", {
      time: new Date().toISOString(),
      kind,
      detail: String(detail == null ? "" : detail).slice(0, 200)
    });
  } catch { /* لا نكسر الطلب أبدًا بسبب فشل تسجيل */ }
}

async function redisFetch(path) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}${path}`;
  return fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
}

/**
 * فحص فقط (بدون زيادة) — يُستدعى قبل معالجة الطلب لمعرفة هل تجاوزنا
 * السقف العام التقديري أم لا. عند أي تعذّر في الاتصال بـ Redis:
 * Fail-Open (withinCap: true) مع تسجيل الحدث محليًا فقط.
 */
export async function checkGlobalDailyCap(softCap) {
  if (!redisConfigured()) {
    logRedisFailure("not_configured");
    return { withinCap: true, currentCount: 0, failOpen: true };
  }
  const key = GLOBAL_KEY_PREFIX + todayKeyUTC();
  try {
    const res = await redisFetch(`/get/${key}`);
    if (!res.ok) {
      logRedisFailure("get_http_error", res.status);
      return { withinCap: true, currentCount: 0, failOpen: true };
    }
    const data = await res.json();
    const parsed = parseInt(data && data.result, 10);
    const currentCount = Number.isFinite(parsed) ? parsed : 0;
    return { withinCap: currentCount < softCap, currentCount, failOpen: false };
  } catch (e) {
    logRedisFailure("get_exception", e && e.message);
    return { withinCap: true, currentCount: 0, failOpen: true };
  }
}

/**
 * زيادة العدّاد العام — تُستدعى فقط بعد نجاح استدعاء الذكاء الاصطناعي
 * فعلياً، بنفس فلسفة عدم احتساب المحاولات الفاشلة المعتمدة في هذا
 * الملف بالكامل. عند أي تعذّر في الاتصال بـ Redis: Fail-Open (لا
 * نرمي أي استثناء يكسر الاستجابة الناجحة للمستخدم) مع تسجيل محلي فقط.
 */
export async function incrementGlobalDailyUsage() {
  if (!redisConfigured()) {
    logRedisFailure("not_configured");
    return;
  }
  const key = GLOBAL_KEY_PREFIX + todayKeyUTC();
  try {
    const res = await redisFetch(`/incr/${key}`);
    if (!res.ok) {
      logRedisFailure("incr_http_error", res.status);
      return;
    }
    const data = await res.json();
    // نضبط TTL فقط عند إنشاء المفتاح لأول مرة في هذا اليوم (النتيجة == 1)،
    // حتى لا نُعيد ضبطه في كل طلب.
    if (data && data.result === 1) {
      try {
        const expireRes = await redisFetch(`/expire/${key}/${GLOBAL_KEY_TTL_SECONDS}`);
        if (!expireRes.ok) logRedisFailure("expire_http_error", expireRes.status);
      } catch (e) {
        logRedisFailure("expire_exception", e && e.message);
      }
    }
  } catch (e) {
    logRedisFailure("incr_exception", e && e.message);
  }
}
