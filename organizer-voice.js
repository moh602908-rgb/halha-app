/* ============================================================
   organizer-voice.js — Voice Reminder Layer: توليد نص الرسالة الصوتية فقط
   ============================================================
   دالة نقية بالكامل: لا speechSynthesis، لا IndexedDB، لا fetch، لا استيراد
   لأي من app.js/ask.js/prompt.js/api/. مُدخلات بيانات ← نص. هذا ما يجعلها
   قابلة للنقل الحرفي إلى منطق Android (Kotlin) لاحقًا دون إعادة تصميم.

   القيد: تُرجع نصًا فقط لأحداث "reminder"، وفقط عندما:
   - settings.voice_reminders_enabled = true، و settings.premium_active = true
     (نقطة الفصل الوحيدة لـPremium؛ Time Core نفسه لا يمر من هنا إطلاقًا).
   - resolvedVoiceEnabled (تذكير محدد يتجاوز الإعداد العام، وإلا يرثه) = true.
   غير ذلك: null. لا نص يُخزَّن أبدًا؛ يُعاد توليده عند كل استهلاك.
   ============================================================ */

/** قوالب لفظية لكل مجال؛ "default" لأي حدث بلا مجال أو مجال غير مذكور هنا. */
const DOMAIN_PHRASES = Object.freeze({
  bills: (title) => `حان موعد تذكيرك بـ ${title}.`,
  car: (title) => `تذكير بشأن السيارة: ${title}.`,
  documents: (title) => `تذكير بوثيقة: ${title}.`,
  family: (title) => `تذكير عائلي: ${title}.`,
  study: (title) => `حان وقت الدراسة: ${title}.`,
  work: (title) => `تذكير عمل: ${title}.`,
  travel: (title) => `تذكير سفر: ${title}.`,
  shopping: (title) => `لا تنسَ: ${title}.`,
  occasions: (title) => `تذكير بمناسبة: ${title}.`,
  default: (title) => `لديك تذكير الآن: ${title}.`,
});

/**
 * resolvedVoiceEnabled: يحسم وراثة voice_enabled (مستوى التذكير) عن الإعداد العام.
 * undefined على مستوى التذكير = يتبع الإعداد العام؛ قيمة صريحة (true/false) تتجاوزه.
 */
function resolveVoiceEnabled(voiceEnabled, generalEnabled) {
  return voiceEnabled === undefined ? generalEnabled : !!voiceEnabled;
}

/**
 * buildVoiceText(event, ctx, settings) → string | null
 * event: عنصر من عقد Exporter (entity_kind, title, domain, ...).
 * ctx: { voiceEnabled } — قيمة voice_enabled الخام من سجل التذكير (قد تكون undefined).
 * settings: من organizer-settings.js (display_name, voice_reminders_enabled, premium_active).
 */
export function buildVoiceText(event, ctx, settings) {
  if (!event || event.entity_kind !== "reminder") return null;
  if (!settings || !settings.voice_reminders_enabled || !settings.premium_active) return null;
  const voiceEnabled = resolveVoiceEnabled(ctx && ctx.voiceEnabled, settings.voice_reminders_enabled);
  if (!voiceEnabled) return null;

  const title = (event.title || "").trim();
  if (!title) return null;
  const phrase = (DOMAIN_PHRASES[event.domain] || DOMAIN_PHRASES.default)(title);
  const name = (settings.display_name || "").trim();
  return name ? `${name}، ${phrase}` : phrase;
}
