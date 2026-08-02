/* ============================================================
   lib/providers.js — Provider Manager
   ============================================================ */

async function callClaude({ system, messages, model, maxTokens, apiKey, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 25000);

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Claude provider error: HTTP ${res.status}`);
  }

  const data = await res.json();
  const block = Array.isArray(data.content)
    ? data.content.find(b => b.type === "text")
    : null;

  return block?.text?.trim() || "";
}


async function callGemini({ system, messages, model, maxTokens, apiKey, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 25000);

  const contents = messages.map(m => ({
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
          "x-goog-api-key": apiKey,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: system }]
          },
          contents,
          generationConfig: {
            maxOutputTokens: maxTokens
          }
        }),
        signal: controller.signal
      }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Gemini provider error: HTTP ${res.status}`);
  }

  const data = await res.json();

  const parts = data?.candidates?.[0]?.content?.parts;

  return Array.isArray(parts)
    ? parts.map(p => p.text || "").join("").trim()
    : "";
}


async function callOpenAI() {
  throw new Error("مزوّد OpenAI غير مُفعّل بعد.");
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

  return answer || "عذرًا، لم أستطع إيجاد إجابة الآن.";
}
