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
   المرحلة 3 — العدّاد العام (Best-effort، راجع التوثيق أعلى الملف)
   ============================================================ */

function getGlobalUsageState() {
  if (!globalThis.__dallini_global_usage) {
    globalThis.__dallini_global_usage = { date: todayKeyUTC(), count: 0 };
  }
  const state = globalThis.__dallini_global_usage;
  const today = todayKeyUTC();
  if (state.date !== today) {
    state.date = today;
    state.count = 0;
  }
  return state;
}

/**
 * فحص فقط (بدون زيادة) — يُستدعى قبل معالجة الطلب لمعرفة هل تجاوزنا
 * السقف العام التقديري أم لا.
 */
export function checkGlobalDailyCap(softCap) {
  const state = getGlobalUsageState();
  return { withinCap: state.count < softCap, currentCount: state.count };
}

/**
 * زيادة العدّاد العام — تُستدعى فقط بعد نجاح استدعاء الذكاء الاصطناعي
 * فعلياً، بنفس فلسفة عدم احتساب المحاولات الفاشلة المعتمدة في هذا
 * الملف بالكامل.
 */
export function incrementGlobalDailyUsage() {
  const state = getGlobalUsageState();
  state.count += 1;
}
