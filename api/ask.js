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

import { CONFIG, resolvePlan } from "../lib/config.js";
import { callAIProvider } from "../lib/providers.js";
import { checkAndPrepareUsage } from "../lib/ratelimit.js";
import { buildSystemPrompt, sanitizeHistory, sanitizeGuides } from "../lib/prompt.js";

function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(extraHeaders || {}) }
  });
}

function checkSameOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true; // لا رأس Origin (طلب مباشر من الخادم مثلاً) — نسمح به
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

  // نقطة التوسع الوحيدة لتحديد خطة المستخدم (مجاني/مميز) — راجع lib/config.js
  const { dailyLimit, model } = resolvePlan();

  const usage = await checkAndPrepareUsage(req, {
    cookieName: CONFIG.RATE_LIMIT_COOKIE_NAME,
    secret: rateLimitSecret,
    dailyLimit,
    maxAgeSeconds: CONFIG.SECONDS_PER_DAY
  });

  if (!usage.allowed) {
    logSecurityEvent("limit_reached", req);
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
    answer = await callAIProvider(CONFIG.ACTIVE_PROVIDER, {
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
    return jsonResponse({ error: "ai_error" }, 502);
  }

  const { cookieHeader, remaining } = await usage.commit();

  return jsonResponse(
    { answer, remaining, limit: dailyLimit },
    200,
    { "Set-Cookie": cookieHeader }
  );
}
