/* ============================================================
   organizer-voice.js — Voice Reminder Layer: توليد نص الرسالة الصوتية فقط
   ============================================================
   دالة نقية بالكامل: لا speechSynthesis، لا IndexedDB، لا fetch، لا Math.random، لا استيراد
   لأي من app.js/ask.js/prompt.js/api/. مُدخلات بيانات ← نص. هذا ما يجعلها
   قابلة للنقل الحرفي إلى منطق Android (Kotlin) لاحقًا دون إعادة تصميم.

   القيد: تُرجع نصًا فقط لأحداث "reminder" و"alarm" (المؤقت والعدّ التنازلي لا صوت لهما)، وفقط عندما:
   - settings.voice_reminders_enabled = true، و settings.premium_active = true
     (نقطة الفصل الوحيدة لـPremium؛ Time Core نفسه والإشعار الأساسي لا يمرّان من هنا إطلاقًا).
   - resolvedVoiceEnabled (تذكير محدد يتجاوز الإعداد العام، وإلا يرثه) = true.
   غير ذلك: null. لا نص يُخزَّن أبدًا؛ يُعاد توليده عند كل استهلاك.

   Smart Voice (Premium) — حتمي بالكامل:
   - تنويع الصياغة: 3 قوالب لكل مجال (وللحالة الافتراضية)؛ الاختيار = FNV-1a(event_id) mod عدد القوالب،
     فنفس event_id في نفس الظروف يعطي نفس الجملة دائمًا، ويتنوّع بين الأيام لأن event_id يحمل لحظة الإطلاق.
   - الوعي بالمجال: قوالب لكل domain معروف.
   - الوعي بالأولوية: priority="high" ← "تنبيه مهم:" قبل الجملة (priority حقل موجود أصلًا في الموعد).
   - الوعي بوقت اليوم: 05:00–11:59 ← "صباح الخير"، 17:00–21:59 ← "مساء الخير" (بتوقيت الجهاز من fire_at)، وغير ذلك بلا تحية.
   - الاسم (display_name): Premium فقط، في بداية الجملة.
   - لا دمج عدة أحداث في جملة واحدة (خارج نطاق هذه الحزمة).
   ============================================================ */

/** قوالب لفظية لكل مجال (3 لكل منها)؛ "default" لأي حدث بلا مجال أو مجال غير مذكور هنا. */
const DOMAIN_PHRASES = Object.freeze({
  bills: [
    (t) => `حان موعد تذكيرك بـ ${t}.`,
    (t) => `لا تنسَ سداد الفاتورة: ${t}.`,
    (t) => `تذكير بالفواتير: ${t}.`,
  ],
  car: [
    (t) => `تذكير بشأن السيارة: ${t}.`,
    (t) => `السيارة تحتاج انتباهك: ${t}.`,
    (t) => `لا تنسَ أمر السيارة: ${t}.`,
  ],
  documents: [
    (t) => `تذكير بوثيقة: ${t}.`,
    (t) => `لا تنسَ وثيقتك: ${t}.`,
    (t) => `حان وقت الوثيقة: ${t}.`,
  ],
  family: [
    (t) => `تذكير عائلي: ${t}.`,
    (t) => `لأسرتك: ${t}.`,
    (t) => `لا تنسَ شأن العائلة: ${t}.`,
  ],
  study: [
    (t) => `حان وقت الدراسة: ${t}.`,
    (t) => `تذكير دراسي: ${t}.`,
    (t) => `لا تنسَ دراستك: ${t}.`,
  ],
  work: [
    (t) => `تذكير عمل: ${t}.`,
    (t) => `موعد عمل قريب: ${t}.`,
    (t) => `لا تنسَ مهمة العمل: ${t}.`,
  ],
  travel: [
    (t) => `تذكير سفر: ${t}.`,
    (t) => `لا تنسَ شأن السفر: ${t}.`,
    (t) => `حان موعد السفر: ${t}.`,
  ],
  shopping: [
    (t) => `لا تنسَ: ${t}.`,
    (t) => `تذكير بالتسوّق: ${t}.`,
    (t) => `قائمتك تنتظر: ${t}.`,
  ],
  occasions: [
    (t) => `تذكير بمناسبة: ${t}.`,
    (t) => `لا تنسَ المناسبة: ${t}.`,
    (t) => `حانت المناسبة: ${t}.`,
  ],
  default: [
    (t) => `لديك تذكير الآن: ${t}.`,
    (t) => `تذكير: ${t}.`,
    (t) => `حان وقت: ${t}.`,
  ],
});

/** قوالب المنبّه (3): المنبّه بلا مجال، فيُستعمل قالب خاص به؛ الأولوية ووقت اليوم والاسم تعمل كما للتذكير. */
const ALARM_PHRASES = Object.freeze([
  (t) => `حان موعد المنبّه: ${t}.`,
  (t) => `منبّهك يرنّ الآن: ${t}.`,
  (t) => `انتبه، المنبّه: ${t}.`,
]);

/** FNV-1a 32-bit: تجزئة حتمية بلا Math.random (نفس الإدخال ← نفس الرقم دائمًا، على أي منصة). */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * resolvedVoiceEnabled: يحسم وراثة voice_enabled (مستوى التذكير) عن الإعداد العام.
 * undefined على مستوى التذكير = يتبع الإعداد العام؛ قيمة صريحة (true/false) تتجاوزه.
 */
function resolveVoiceEnabled(voiceEnabled, generalEnabled) {
  return voiceEnabled === undefined ? generalEnabled : !!voiceEnabled;
}

/** تحية وقت اليوم من لحظة الإطلاق (بتوقيت الجهاز)، أو null. */
function dayPartGreeting(fireAt) {
  if (!fireAt) return null;
  const d = new Date(fireAt);
  if (Number.isNaN(d.getTime())) return null;
  const h = d.getHours();
  if (h >= 5 && h < 12) return "صباح الخير";
  if (h >= 17 && h < 22) return "مساء الخير";
  return null;
}

/**
 * buildVoiceText(event, ctx, settings) → string | null
 * event: عنصر من عقد Exporter (entity_kind, title, domain, event_id, fire_at, ...).
 * ctx: { voiceEnabled, priority } — voice_enabled الخام من سجل التذكير (قد تكون undefined)، وpriority الموعد (اختياري).
 * settings: من organizer-settings.js (display_name, voice_reminders_enabled, premium_active).
 */
export function buildVoiceText(event, ctx, settings) {
  if (!event || (event.entity_kind !== "reminder" && event.entity_kind !== "alarm")) return null;
  if (!settings || !settings.voice_reminders_enabled || !settings.premium_active) return null;
  const voiceEnabled = resolveVoiceEnabled(ctx && ctx.voiceEnabled, settings.voice_reminders_enabled);
  if (!voiceEnabled) return null;

  const title = (event.title || "").trim();
  if (!title) return null;

  const templates = event.entity_kind === "alarm" ? ALARM_PHRASES : (DOMAIN_PHRASES[event.domain] || DOMAIN_PHRASES.default);
  const key = String(event.event_id || event.dedup_key || title);
  const phrase = templates[hash32(key) % templates.length](title);

  const name = (settings.display_name || "").trim();
  const opening = [name, dayPartGreeting(event.fire_at)].filter(Boolean).join("، ");
  const urgent = ctx && ctx.priority === "high" ? "تنبيه مهم: " : "";
  return `${opening ? opening + ". " : ""}${urgent}${phrase}`;
}
