/* ============================================================
   /api/ask — بوابة خلفية آمنة بين التطبيق والذكاء الاصطناعي
   ============================================================
   لماذا هذا الملف موجود:
   التطبيق Frontend فقط، وأي مفتاح API يوضع مباشرة في app.js يصبح
   مرئيًا لأي شخص يفحص الكود من متصفحه. الحل المعياري: دالة خادم صغيرة
   (Edge Function) تعمل على Vercel، تحتفظ بالمفتاح في متغير بيئة سرّي
   لا يصل إليه المتصفح أبدًا (لا في الشيفرة، لا في HTML، لا في الشبكة
   من جهة العميل)، ويتصل بها التطبيق بدل الاتصال المباشر بالمزوّد.

   هذا الملف "رقيق" عمدًا — لا يحتوي أي تفاصيل خاصة بمزوّد معيّن ولا
   أي أرقام إعداد مباشرة؛ كل ذلك معزول في lib/config.js وlib/providers.js
   وlib/ratelimit.js وlib/prompt.js. هذا يجعل الصيانة والتوسع لاحقًا
   (مزوّد جديد، خطة مدفوعة، حسابات مستخدمين) تعديلاً في ملف واحد مركّز
   بدل تعديل هذا الملف نفسه في كل مرة.

   الأمان (بالتفصيل):
   1) AI_API_KEY يعيش فقط في إعدادات Vercel كمتغير بيئة سرّي — غير
      موجود في أي ملف بالمشروع، وبالتالي غير موجود في Git ولا في أي
      كود يصل للمتصفح مطلقًا. لا Developer Tools ولا View Source ولا
      تبويب Network يمكنه كشفه، لأنه لا يُرسل للمتصفح أصلاً في أي وقت.
   2) الحد المجاني اليومي محمي بكوكي موقّعة رقميًا (lib/ratelimit.js)
      بمفتاح سرّي ثانٍ (RATE_LIMIT_SECRET) مختلف تمامًا عن مفتاح
      الذكاء الاصطناعي، بدون أي قاعدة بيانات خارجية.
   3) هذه الدالة تعمل فقط عند الاتصال بها من نفس نطاق الموقع (فحص
      Origin)، فلا يمكن لموقع آخر استخدام مفتاحك لتشغيل تطبيقه هو.
   ============================================================ */

export const config = { runtime: "edge" };

import { CONFIG, resolvePlan } from "./_lib/config.js";
import { resolveAndCall } from "./_lib/providerManager.js";
import { checkAndPrepareUsage, checkGlobalDailyCap, incrementGlobalDailyUsage } from "./_lib/ratelimit.js";
import { buildSystemPrompt, sanitizeHistory, sanitizeGuides } from "./_lib/prompt.js";
import { recordEvent } from "./_lib/monitor.js";

function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(extraHeaders || {}) }
  });
}

function checkSameOrigin(req) {
  const origin = req.headers.get("origin");
  // المرحلة 3: كان يُسمح سابقاً بغياب Origin تماماً (طلبات curl/سكربتات
  // مباشرة تتجاوز هذا الفحص كلياً). التطبيق الحالي (PWA) يرسل Origin
  // دائماً في طلبات POST من نفس النطاق، فلا حاجة شرعية للسماح بغيابه.
  if (!origin) return false;
  const host = req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// سجلّ بسيط لمحاولات مشبوهة — يظهر في Vercel Logs (Project → Logs)، بدون أي
// قاعدة بيانات. مفيد لمراقبة أنماط إساءة استخدام يدويًا عند الحاجة.
function logSecurityEvent(kind, req) {
  try {
    console.warn(`[dallini-security] ${kind}`, {
      time: new Date().toISOString(),
      origin: req.headers.get("origin") || "(none)",
      ua: (req.headers.get("user-agent") || "").slice(0, 120)
    });
  } catch { /* لا نكسر الطلب أبدًا بسبب فشل تسجيل */ }
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  if (!checkSameOrigin(req)) {
    logSecurityEvent("forbidden_origin", req);
    recordEvent("origin_block");
    return jsonResponse({ error: "forbidden_origin" }, 403);
  }

  // Defense in depth: تحقق من Content-Type قبل محاولة القراءة كـ JSON.
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return jsonResponse({ error: "unsupported_content_type" }, 415);
  }

  // Defense in depth: ارفض أي جسم طلب أكبر من المعقول قبل قراءته بالكامل،
  // لتفادي إرهاق الخادم بحمولات ضخمة مقصودة (DoS بسيط).
  const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
  if (contentLength > CONFIG.MAX_BODY_BYTES) {
    logSecurityEvent("payload_too_large", req);
    recordEvent("validation_error");
    return jsonResponse({ error: "payload_too_large" }, 413);
  }

  const apiKey = process.env.AI_API_KEY;
  const rateLimitSecret = process.env.RATE_LIMIT_SECRET;
  if (!apiKey || !rateLimitSecret) {
    // متغيرات البيئة غير مُعدّة بعد على Vercel — راجع قسم "المرحلة الثانية" في README.
    return jsonResponse({ error: "server_not_configured" }, 500);
  }

  let rawText;
  try {
    rawText = await req.text();
  } catch {
    return jsonResponse({ error: "bad_request" }, 400);
  }
  // تحقق ثانٍ من الحجم الفعلي (Content-Length قد يكون غائبًا أو غير دقيق مع
  // بعض العملاء)، بعد القراءة مباشرة وقبل أي معالجة أخرى.
  if (rawText.length > CONFIG.MAX_BODY_BYTES) {
    logSecurityEvent("payload_too_large_actual", req);
    recordEvent("validation_error");
    return jsonResponse({ error: "payload_too_large" }, 413);
  }

  let body;
  try {
    body = JSON.parse(rawText);
  } catch {
    return jsonResponse({ error: "bad_request" }, 400);
  }

  const question = String(body?.question || "").trim().slice(0, CONFIG.MAX_QUESTION_LENGTH);
  if (!question) {
    return jsonResponse({ error: "empty_question" }, 400);
  }

  // المرحلة 3: فحص السقف العام التقديري أولاً (Best-effort، راجع
  // lib/ratelimit.js) — لا يستهلك شيئاً بحد ذاته، فحص فقط.
  const globalCheck = checkGlobalDailyCap(CONFIG.GLOBAL_DAILY_SOFT_CAP);
  if (!globalCheck.withinCap) {
    logSecurityEvent("global_cap_reached", req);
    recordEvent("quota_limit");
    return jsonResponse({ error: "service_busy" }, 429);
  }

  // نقطة التوسع الوحيدة لتحديد خطة المستخدم (مجاني/مميز) — راجع lib/config.js
  const { dailyLimit, model } = resolvePlan();

  const usage = await checkAndPrepareUsage(req, {
    cookieName: CONFIG.RATE_LIMIT_COOKIE_NAME,
    secret: rateLimitSecret,
    dailyLimit,
    maxAgeSeconds: CONFIG.SECONDS_PER_DAY,
    minRequestIntervalMs: CONFIG.MIN_REQUEST_INTERVAL_MS
  });

  if (usage.throttled) {
    // المرحلة 3: رفض بسبب سرعة الإرسال فقط — لا يُحتسب من الرصيد اليومي،
    // ورسالة مختلفة عمداً عن limit_reached حتى لا يظن المستخدم أن حصته
    // اليومية انتهت.
    recordEvent("too_fast");
    return jsonResponse({ error: "too_fast", retryAfterMs: usage.retryAfterMs }, 429);
  }

  if (!usage.allowed) {
    logSecurityEvent("limit_reached", req);
    recordEvent("quota_limit");
    return jsonResponse({
      error: "limit_reached",
      remaining: 0,
      limit: dailyLimit,
      resetHint: "يتجدد الحد اليومي عند منتصف الليل بتوقيت غرينتش (UTC)."
    }, 429);
  }

  const history = sanitizeHistory(body?.history, CONFIG.MAX_HISTORY_MESSAGES, CONFIG.MAX_MESSAGE_CHARS);
  const guideContext = sanitizeGuides(body?.guides, CONFIG.MAX_GUIDES_CONTEXT);
  const system = buildSystemPrompt(guideContext);
  const messages = [...history, { role: "user", content: question }];

  let answer;
  try {
    answer = await resolveAndCall({
      system,
      messages,
      model,
      maxTokens: CONFIG.MAX_TOKENS,
      apiKey,
      timeoutMs: CONFIG.PROVIDER_TIMEOUT_MS
    });
  } catch (e) {
    // نسجّل نص الخطأ الفعلي (بدون أي مفتاح فيه أبدًا) في سجلات Vercel، حتى
    // نستطيع تشخيص سبب الفشل الحقيقي بدل تخمينه من رمز 502 وحده.
    console.warn("[dallini-security] ai_provider_error", {
      time: new Date().toISOString(),
      detail: String(e && e.message ? e.message : e).slice(0, 300)
    });
    recordEvent("provider_error");
    return jsonResponse({ error: "ai_error" }, 502);
  }

  // المرحلة 3: نزيد العدّاد العام فقط بعد نجاح فعلي، بنفس منطق usage.commit()
  // أعلاه — طلب فشل لا يُحتسب من أي عدّاد (فردي أو عام).
  incrementGlobalDailyUsage();

  const { cookieHeader, remaining } = await usage.commit();

  return jsonResponse(
    { answer, remaining, limit: dailyLimit },
    200,
    { "Set-Cookie": cookieHeader }
  );
}
