/* ============================================================
   api/_lib/ownerAuth.js — حماية موحّدة لكل نقاط Owner Dashboard
   ============================================================
   مستخرج من api/owner-status.js (الإصدار السابق) دون أي تغيير في:
   - خوارزمية HMAC / مقارنة SHA-256 بزمن ثابت (timingSafeEqual).
   - منطق التحقق من OWNER_ACCESS_KEY (Fail-closed عند غياب الإعداد).
   - شكل رد الرفض الموحّد (404، { error: "not_found" }) لكل حالات
     فشل المصادقة (مفتاح مفقود/خاطئ/لوحة غير مُعدّة/أثناء تهدئة).
   - سلوك "GET فقط، وإلا 405".
   - قيم CONFIG المستخدمة (MONITOR_WINDOW_MINUTES،
     OWNER_AUTH_FAIL_THRESHOLD، OWNER_COOLDOWN_MINUTES).

   ------------------------------------------------------------
   تغيير أمني مقصود (معتمد صراحة، وليس نقلاً حرفيًا):
   ------------------------------------------------------------
   حالة حارس محاولات المصادقة (globalThis.__dallini_owner_auth_guard)
   أصبحت مشتركة بين كل نقاط Owner Dashboard التي تستورد هذه الوحدة
   (owner-status، owner-protection، وما سيُضاف لاحقًا)، بدل أن تكون
   خاصة بنقطة واحدة كما كانت. الحماية الآن على مستوى "سطح المالك"
   بالكامل: محاولة فاشلة على أي نقطة تُحسب على الجميع، وتجاوز العتبة
   يُفعّل تهدئة تمنع الوصول لكل نقاط المالك دفعة واحدة حتى انتهاء
   مدتها — لا فرق آخر في منطق الحماية الداخلي عن السلوك السابق.
   ============================================================ */

import { CONFIG } from "./config.js";
import { recordEvent } from "./monitor.js";

const UNIFIED_REJECTION = { error: "not_found" };
const HEADER_NAME = "x-owner-access-key";

export function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function unifiedRejection() {
  recordEvent("owner_auth_failed");
  return jsonResponse(UNIFIED_REJECTION, 404);
}

// ------------------------------------------------------------
// حالة الحارس — مشتركة الآن عبر كل نقاط المالك (التغيير الأمني
// المقصود الموثَّق أعلاه). المنطق الداخلي (نافذة ثابتة + تهدئة)
// مطابق تمامًا لما كان في owner-status.js.
// ------------------------------------------------------------
function getAuthGuardState() {
  if (!globalThis.__dallini_owner_auth_guard) {
    globalThis.__dallini_owner_auth_guard = {
      windowStartedAt: 0,
      failCount: 0,
      cooldownUntil: 0
    };
  }
  return globalThis.__dallini_owner_auth_guard;
}

function isCoolingDown(guard, now) {
  return guard.cooldownUntil > now;
}

function registerAuthFailure(guard, now) {
  const windowMs = CONFIG.MONITOR_WINDOW_MINUTES * 60 * 1000;
  if (now - guard.windowStartedAt > windowMs) {
    guard.windowStartedAt = now;
    guard.failCount = 0;
  }
  guard.failCount += 1;

  if (guard.failCount > CONFIG.OWNER_AUTH_FAIL_THRESHOLD) {
    guard.cooldownUntil = now + CONFIG.OWNER_COOLDOWN_MINUTES * 60 * 1000;
  }
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function isValidOwnerKey(providedKey) {
  const configuredKey = CONFIG.OWNER_ACCESS_KEY;
  if (!configuredKey || !providedKey) return false;
  const [a, b] = await Promise.all([sha256(configuredKey), sha256(providedKey)]);
  return timingSafeEqual(a, b);
}

/**
 * حارس موحّد لكل نقاط Owner Dashboard — يُستدعى كأول سطر في كل نقطة.
 * يُرجع Response جاهزة للإرجاع فورًا عند الرفض (405 لطريقة غير GET،
 * أو 404 الموحّد لأي فشل مصادقة/تهدئة نشطة)، أو null عند النجاح
 * (تكمل نقطة الـ API تنفيذها الخاص بعدها).
 */
export async function guardOwnerRequest(req) {
  if (req.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const guard = getAuthGuardState();
  const now = Date.now();

  if (isCoolingDown(guard, now)) {
    return unifiedRejection();
  }

  const providedKey = req.headers.get(HEADER_NAME) || "";

  const valid = await isValidOwnerKey(providedKey);
  if (!valid) {
    registerAuthFailure(guard, now);
    return unifiedRejection();
  }

  return null;
}
