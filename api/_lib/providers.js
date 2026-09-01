/* ============================================================
   lib/providers.js — Provider Manager
   ============================================================
   الهدف: عزل كامل بين "منطق التطبيق" (api/ask.js) و"تفاصيل أي مزوّد
   ذكاء اصطناعي بعينه". أي ملف آخر بالمشروع لا يعرف شكل طلب Claude أو
   Gemini أو OpenAI إطلاقًا، ولا يستدعي إلا callAIProvider(...) أدناه.

   لإضافة مزوّد جديد لاحقًا:
   1) اكتب دالة adapter جديدة بنفس التوقيع: async ({system, messages,
      model, maxTokens, apiKey}) => string
   2) سجّلها في كائن PROVIDERS بالأسفل باسم قصير (مثل "gemini").
   3) غيّر متغير البيئة AI_PROVIDER إلى ذلك الاسم.
   لا حاجة لأي تعديل في api/ask.js أو lib/config.js أو الواجهة الأمامية.
   ============================================================ */

// دالة مساعدة داخلية فقط: تُنشئ خطأً عادياً بنفس نص الرسالة كما كان تماماً،
// وتُرفق به خاصية إضافية retryable (true = خطأ مؤقت يستحق تجربة محرك بديل
// لاحقاً، false = خطأ نهائي لا فائدة من إعادة المحاولة به). هذه الخاصية غير
// مقروءة من أي مكان حالياً — لا تغيّر أي سلوك ظاهر للمستخدم أو في Logs.
function taggedError(message, retryable) {
  const err = new Error(message);
  err.retryable = retryable;
  return err;
}

// ---------- Claude (Anthropic) — المزوّد النشط حاليًا ----------
async function callClaude({ system, messages, model, maxTokens, apiKey, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 25_000);
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
      signal: controller.signal
    });
  } catch (e) {
    throw taggedError(e && e.name === "AbortError" ? "Claude provider timeout" : "Claude provider network error", true);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // 401 (مفتاح غير صالح) و404 (نموذج غير موجود) أخطاء نهائية — لا فائدة من
    // إعادة المحاولة بنفس الإعدادات. 429/5xx غالباً مؤقتة (تحميل زائد مؤقت).
    const isFinal = res.status === 401 || res.status === 403 || res.status === 404;
    throw taggedError(`Claude provider error: HTTP ${res.status}`, !isFinal);
  }
  const data = await res.json();
  const block = Array.isArray(data.content) ? data.content.find(b => b.type === "text") : null;
  return (block && block.text && block.text.trim()) || "";
}

// ---------- Google Gemini ----------
async function callGemini({ system, messages, model, maxTokens, apiKey, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 25_000);

  // Gemini يستخدم role: "user" أو "model" (بدل "assistant")، ويفصل توجيه
  // النظام (system) عن سجل المحادثة في حقل مستقل system_instruction.
  const contents = (messages || []).map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));

  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { maxOutputTokens: maxTokens }
        }),
        signal: controller.signal
      }
    );
  } catch (e) {
    throw taggedError(e && e.name === "AbortError" ? "Gemini provider timeout" : "Gemini provider network error", true);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // نقرأ نص رسالة الخطأ الفعلية القادمة من Google (بدون كشف المفتاح نفسه أبدًا،
    // فهو غير موجود في نص هذا الرد إطلاقًا) لتظهر في سجلات Vercel ونعرف السبب
    // الحقيقي للرفض (مفتاح غير صالح، تجاوز حد الاستخدام، صلاحيات غير مفعّلة...).
    let detail = "";
    try {
      const errBody = await res.text();
      detail = errBody.slice(0, 300);
    } catch { /* تجاهل فشل قراءة نص الخطأ */ }
    // نفس منطق التصنيف المستخدم مع Claude أعلاه: 401/403/404 أخطاء نهائية
    // (مفتاح غير صالح، صلاحيات، أو نموذج غير موجود)، وما عداها (429 تجاوز
    // حصة مؤقت، 5xx مشكلة مؤقتة عند Google) يستحق تجربة محرك بديل لاحقاً.
    const isFinal = res.status === 401 || res.status === 403 || res.status === 404;
    throw taggedError(`Gemini provider error: HTTP ${res.status} — ${detail}`, !isFinal);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map(p => p.text || "").join("") : "";
  return text.trim();
}

async function callOpenAI() {
  throw taggedError("مزوّد OpenAI غير مُفعّل بعد. أضف التنفيذ في lib/providers.js عند الحاجة.", false);
}

const PROVIDERS = {
  claude: callClaude,
  gemini: callGemini,
  openai: callOpenAI
};

export function isProviderSupported(providerName) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, providerName);
}

export async function callAIProvider(providerName, params) {
  const adapter = PROVIDERS[providerName];
  if (!adapter) {
    throw taggedError("مزوّد ذكاء اصطناعي غير معروف: " + providerName, false);
  }
  const answer = await adapter(params);
  return answer || "عذرًا، لم أستطع إيجاد إجابة واضحة الآن. جرّب إعادة صياغة سؤالك.";
}
