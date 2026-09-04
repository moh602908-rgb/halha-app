/* ============================================================
   /api/owner-status — نقطة قراءة فقط خاصة بالمالك (Owner Dashboard)
   ============================================================
   معزولة تمامًا عن /api/ask ومسار المستخدم العادي:
   - لا تستورد ratelimit.js الخاص بكوكيز المستخدمين (قراءة عدّاد
     السقف اليومي العام فقط، وهو رقم مجمّع عام لا صلة له بأي كوكي
     أو مستخدم فردي).
   - لا تستورد intent.js ولا providers.js ولا providerManager.js
     ولا prompt.js — لا علاقة لها بمسار توليد الإجابات إطلاقًا.
   - مفتاح مصادقة مستقل كليًا (OWNER_ACCESS_KEY) عن AI_API_KEY
     وRATE_LIMIT_SECRET — تسرّب أي منهما لا يكشف الآخر.

   الصلاحيات: GET فقط، قراءة فقط، صفر أي إمكانية تعديل أو كتابة.

   البيانات المُرجعة: عدّادات مجمّعة (Enum مغلق من monitor.js) وحالة
   إعداد عامة (اسم المزوّد/النموذج، هل طبقة Intent مفعّلة، السقف
   اليومي العام مقابل الاستهلاك الحالي) — لا شيء آخر. لا IP، لا
   User-Agent، لا نص سؤال، لا أي معرّف فردي في أي مكان من هذا الملف.

   قيمة OWNER_ACCESS_KEY نفسها لا تُعرض أبدًا في أي استجابة — فقط
   حالة "مُعدّة أم لا" عند الحاجة (غير مُستخدمة في هذا الإصدار أصلاً).
   ============================================================ */

export const config = { runtime: "edge" };

import { CONFIG } from "./_lib/config.js";
import { getSnapshot, recordEvent } from "./_lib/monitor.js";
import { checkGlobalDailyCap } from "./_lib/ratelimit.js";

const UNIFIED_REJECTION = { error: "not_found" };
const HEADER_NAME = "x-owner-access-key";

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

// رفض موحّد تمامًا لكل حالات فشل المصادقة (مفتاح مفقود/خاطئ/عبر
// Query String/اللوحة غير مُعدّة أصلًا) — نفس الرمز ونفس الجسم حرفيًا،
// بلا أي فرق قابل للاستنتاج. الرمز 404 (لا 401/403) متعمَّد: لا يكشف
// حتى وجود نقطة API نفسها لمن لا يملك المفتاح الصحيح.
function unifiedRejection() {
  recordEvent("owner_auth_failed");
  return jsonResponse(UNIFIED_REJECTION, 404);
}

// ------------------------------------------------------------
// حماية معدّل محاولات المصادقة — عامة (لا تتبع فاعل)، بنفس فلسفة
// "مراقبة الظاهرة لا الفاعل" المعتمدة في monitor.js. حالة بسيطة
// (نافذة ثابتة بدل حاويات دوّارة — كافية هنا لأن هذا العدّاد يخصّ
// نقطة وصول واحدة منخفضة الحركة، لا مسار مستخدمين عامًا).
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

// true = ممنوع حاليًا بسبب تهدئة نشطة (بغض النظر عن صحة المفتاح).
function isCoolingDown(guard, now) {
  return guard.cooldownUntil > now;
}

// يُستدعى بعد كل محاولة مصادقة فاشلة فقط. يُدير النافذة الثابتة
// ويُفعّل التهدئة عند تجاوز العتبة.
function registerAuthFailure(guard, now) {
  const windowMs = CONFIG.MONITOR_WINDOW_MINUTES * 60 * 1000;
  if (now - guard.windowStartedAt > windowMs) {
    // النافذة انتهت — بداية نافذة جديدة من هذه المحاولة.
    guard.windowStartedAt = now;
    guard.failCount = 0;
  }
  guard.failCount += 1;

  if (guard.failCount > CONFIG.OWNER_AUTH_FAIL_THRESHOLD) {
    // "تجاوز" العتبة (بنفس معنى reject_flood_detected في monitor.js:
    // أكثر من العتبة، لا عندها بالضبط) — تفعيل تهدئة ثابتة المدة.
    guard.cooldownUntil = now + CONFIG.OWNER_COOLDOWN_MINUTES * 60 * 1000;
  }
}

// مقارنة بزمن ثابت عبر تجزئة SHA-256 لكلا الطرفين أولًا (Web Crypto،
// متاحة أصلًا في بيئة Edge) — تُنتج دومًا مخرجًا بطول ثابت (32 بايت)
// بغض النظر عن طول المدخل، فتُزال أي إمكانية لتسريب طول المفتاح أو
// نقطة أول اختلاف عبر توقيت المقارنة.
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

function timingSafeEqual(a, b) {
  // نفس الطول دائمًا هنا (مخرجا SHA-256)، لكن نتحقق دفاعًا في العمق.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function isValidOwnerKey(providedKey) {
  const configuredKey = CONFIG.OWNER_ACCESS_KEY;
  // Fail-closed: لوحة غير مُعدّة (لا مفتاح على Vercel) = رفض دائمًا،
  // بلا استثناء، حتى لو أُرسل مفتاح فارغ يطابق القيمة الافتراضية الفارغة.
  if (!configuredKey || !providedKey) return false;
  const [a, b] = await Promise.all([sha256(configuredKey), sha256(providedKey)]);
  return timingSafeEqual(a, b);
}

export default async function handler(req) {
  if (req.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const guard = getAuthGuardState();
  const now = Date.now();

  if (isCoolingDown(guard, now)) {
    // أثناء التهدئة: رفض موحّد حتى لمفتاح صحيح، بلا زيادة إضافية على
    // عدّاد الفشل نفسه (مدة ثابتة، لا تمديد ذاتي لا نهائي).
    return unifiedRejection();
  }

  // المفتاح عبر Header فقط — لا قراءة لأي Query String نهائيًا، فمفتاح
  // مُرسَل عبر الرابط يُعامَل تلقائيًا كمفتاح غائب تمامًا (نفس المسار،
  // نفس الاستجابة، بلا أي فرع كود خاص يميّزه).
  const providedKey = req.headers.get(HEADER_NAME) || "";

  const valid = await isValidOwnerKey(providedKey);
  if (!valid) {
    registerAuthFailure(guard, now);
    return unifiedRejection();
  }

  // نجاح المصادقة — لا تصفير فوري لعدّاد الفشل هنا عمدًا: نافذة الفشل
  // تُدار زمنيًا فقط (أعلاه)، فلا يمنح النجاح فرصة إضافية لتخمين لاحق.

  const snapshot = getSnapshot();
  const globalUsage = checkGlobalDailyCap(CONFIG.GLOBAL_DAILY_SOFT_CAP);

  return jsonResponse({
    date: snapshot ? snapshot.date : null,
    events: snapshot ? snapshot.counts : null,
    window: snapshot ? snapshot.window : null,
    config: {
      enableIntentLayer: CONFIG.ENABLE_INTENT_LAYER,
      activeProvider: CONFIG.ACTIVE_PROVIDER,
      defaultModel: CONFIG.DEFAULT_MODEL
    },
    usage: {
      dailyGlobalCount: globalUsage.currentCount,
      dailyGlobalCap: CONFIG.GLOBAL_DAILY_SOFT_CAP,
      withinCap: globalUsage.withinCap
    }
  }, 200);
}
