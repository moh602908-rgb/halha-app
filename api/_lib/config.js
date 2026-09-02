function envInt(name, fallback) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envStr(name, fallback) {
  const v = process.env[name];
  return (typeof v === "string" && v.trim()) ? v.trim() : fallback;
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (typeof v !== "string") return fallback;
  return v.trim().toLowerCase() === "true";
}

export const CONFIG = {
  FREE_DAILY_LIMIT: envInt("FREE_DAILY_LIMIT", 10),
  PREMIUM_DAILY_LIMIT: envInt("PREMIUM_DAILY_LIMIT", 50),

  ACTIVE_PROVIDER: envStr("AI_PROVIDER", "gemini"),
  // ترتيب أولوية المحركات لطبقة providerManager.js. حالياً محرك واحد فقط
  // (نفس ACTIVE_PROVIDER أعلاه) — أي سلوك مطابق تماماً للوضع الحالي. لإضافة
  // محرك احتياطي مستقبلاً: PROVIDER_CHAIN: ["gemini", "claude"] مثلاً.
  PROVIDER_CHAIN: [envStr("AI_PROVIDER", "gemini")],
  DEFAULT_MODEL: envStr("DEFAULT_MODEL", "gemini-2.5-flash-lite"),
  PREMIUM_MODEL: envStr("PREMIUM_MODEL", "gemini-2.5-flash"),

  MAX_TOKENS: envInt("MAX_TOKENS", 700),
  MAX_QUESTION_LENGTH: 500,
  MAX_HISTORY_MESSAGES: 6,
  MAX_MESSAGE_CHARS: 2000,
  MAX_GUIDES_CONTEXT: 3,

  MAX_BODY_BYTES: envInt("MAX_BODY_BYTES", 80000),
  PROVIDER_TIMEOUT_MS: envInt("PROVIDER_TIMEOUT_MS", 20000),

  // المرحلة 3 — تقوية الأمان: الحد الأدنى بين طلبين متتاليين لنفس المستخدم
  // (Throttling)، وسقف يومي عام تقديري (Best-effort، راجع lib/ratelimit.js
  // للتفاصيل الكاملة حول حدوده).
  MIN_REQUEST_INTERVAL_MS: envInt("MIN_REQUEST_INTERVAL_MS", 3000),
  GLOBAL_DAILY_SOFT_CAP: envInt("GLOBAL_DAILY_SOFT_CAP", 500),

  RATE_LIMIT_COOKIE_NAME: "dallini_usage",
  SECONDS_PER_DAY: 86400,

  // Phase 12.3 — طبقة تصنيف النوايا المحلية. معطّلة افتراضيًا (Fail-safe)
  // عند غياب المتغير من إعدادات Vercel.
  ENABLE_INTENT_LAYER: envBool("ENABLE_INTENT_LAYER", false)
};

export function resolvePlan() {
  return {
    plan: "free",
    dailyLimit: CONFIG.FREE_DAILY_LIMIT,
    model: CONFIG.DEFAULT_MODEL
  };
}
