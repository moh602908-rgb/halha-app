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

   2) العدّاد العام (globalDailyCheck): محسوب الآن عبر Upstash Redis
      (راجع api/_lib/redisStore.js)، بدل الاعتماد على globalThis —
      هذا يجعله عدّادًا موزّعًا حقيقيًا مشتركًا بين كل نسخ Vercel
      Edge بدل عدّاد منفصل لكل نسخة. سياسة الفشل: Fail-open — أي
      تعذّر في الوصول إلى Redis لا يوقف المستخدم ولا يعطّل ask.js؛
      يُهمَل الفحص/التسجيل لتلك الدورة فقط (راجع redisStore.js).
   ============================================================ */

import { redisIncrWithExpire, redisGetInt } from "./redisStore.js";

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
   المرحلة 3 (محدَّثة) — العدّاد العام عبر Upstash Redis
   ============================================================
   العدّاد العام لم يعد مخزَّنًا في globalThis (راجع التوثيق أعلى
   الملف) بل في Upstash Redis عبر api/_lib/redisStore.js، تحت
   المفتاح dallini:usage:global:{YYYY-MM-DD} مع INCR وTTL محدود
   (90 يومًا) لتفادي تراكم البيانات بلا حدّ.
   ============================================================ */

const GLOBAL_USAGE_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 يومًا

/* ============================================================
   إضافة — فترات نشاط اليوم (00-06/06-12/12-18/18-24) للبطاقة
   الجديدة "رؤية المالك: النشاط والأمان" فقط.
   ============================================================
   الكتابة الجديدة الوحيدة المبرَّرة معماريًا في كل تصميم "رؤية
   المالك" — كل ما هو أسبوعي/شهري/أمني/نشاط عام يُقرأ من مفاتيح
   موجودة أصلًا (owner-insights.js) بلا أي كتابة إضافية. لا تخزين
   لأي معرّف فردي؛ عدّاد مجمّع بالكامل بنفس فلسفة العدّاد اليومي
   أعلاه. الفترات تُحسب كأرباع لليوم الحالي بتوقيت UTC.
   ============================================================ */
const PERIOD_USAGE_TTL_SECONDS = 60 * 60 * 24 * 2; // يومان يكفيان لعرض اليوم الحالي

function currentPeriodIndexUTC() {
  return Math.floor(new Date().getUTCHours() / 6); // 0..3 لكل ربع من 6 ساعات
}

// أربعة مفاتيح فترات اليوم الحالي: 00-06 / 06-12 / 12-18 / 18-24
export function periodKeysForTodayUTC() {
  const date = todayKeyUTC();
  return [0, 1, 2, 3].map(i => `dallini:usage:period:${date}:${i}`);
}

/**
 * فحص فقط (بدون زيادة) — يُستدعى قبل معالجة الطلب لمعرفة هل تجاوزنا
 * السقف العام التقديري أم لا.
 *
 * Fail-open: عند تعذّر الوصول إلى Redis (currentCount === null من
 * redisGetInt)، نعيد withinCap: true دائمًا — أي أن هذا السقف
 * التقديري يتوقف عمليًا أثناء انقطاع Upstash، بينما تبقى الحدود
 * الفردية عبر الكوكي الموقّعة تعمل بشكل مستقل تمامًا وغير متأثرة.
 */
export async function checkGlobalDailyCap(softCap) {
  const key = `dallini:usage:global:${todayKeyUTC()}`;
  const currentCount = await redisGetInt(key);
  if (currentCount === null) {
    return { withinCap: true, currentCount: 0 };
  }
  return { withinCap: currentCount < softCap, currentCount };
}

/**
 * زيادة العدّاد العام — تُستدعى فقط بعد نجاح استدعاء الذكاء الاصطناعي
 * فعلياً، بنفس فلسفة عدم احتساب المحاولات الفاشلة المعتمدة في هذا
 * الملف بالكامل. فشل الكتابة في Redis صامت بالكامل (Fail-open، راجع
 * redisStore.js) ولا يُرمى كاستثناء هنا.
 */
export async function incrementGlobalDailyUsage() {
  const key = `dallini:usage:global:${todayKeyUTC()}`;
  const periodKey = periodKeysForTodayUTC()[currentPeriodIndexUTC()];
  await Promise.all([
    redisIncrWithExpire(key, GLOBAL_USAGE_TTL_SECONDS),
    redisIncrWithExpire(periodKey, PERIOD_USAGE_TTL_SECONDS)
  ]);
}
