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
 */
export async function checkAndPrepareUsage(req, { cookieName, secret, dailyLimit, maxAgeSeconds }) {
  const today = todayKeyUTC();
  const existingCookie = readCookie(req, cookieName);
  const existingUsage = await verifyUsageCookie(existingCookie, secret);
  const currentCount = (existingUsage && existingUsage.date === today && Number.isFinite(existingUsage.count))
    ? existingUsage.count
    : 0;

  const allowed = currentCount < dailyLimit;
  const remaining = Math.max(0, dailyLimit - currentCount);

  async function commit() {
    const newCount = currentCount + 1;
    const value = await signUsageCookie({ date: today, count: newCount }, secret);
    return {
      cookieHeader: `${cookieName}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`,
      remaining: Math.max(0, dailyLimit - newCount)
    };
  }

  return { allowed, remaining, currentCount, commit };
}
