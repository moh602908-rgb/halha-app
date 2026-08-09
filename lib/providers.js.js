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
    throw new Error(e && e.name === "AbortError" ? "Claude provider timeout" : "Claude provider network error");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`Claude provider error: HTTP ${res.status}`);
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
    throw new Error(e && e.name === "AbortError" ? "Gemini provider timeout" : "Gemini provider network error");
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
    throw new Error(`Gemini provider error: HTTP ${res.status} — ${detail}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map(p => p.text || "").join("") : "";
  return text.trim();
}

async function callOpenAI() {
  throw new Error("مزوّد OpenAI غير مُفعّل بعد. أضف التنفيذ في lib/providers.js عند الحاجة.");
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
    throw new Error("مزوّد ذكاء اصطناعي غير معروف: " + providerName);
  }
  const answer = await adapter(params);
  return answer || "عذرًا، لم أستطع إيجاد إجابة واضحة الآن. جرّب إعادة صياغة سؤالك.";
}
