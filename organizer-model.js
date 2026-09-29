/* ============================================================
   organizer-model.js — Organizer Core: النموذج الزمني والحقول الأساسية (Foundation v2)
   ============================================================
   وحدة نقية بلا أي استيراد (لا IndexedDB ولا شبكة) تحدد:
   - الحقول الجديدة للسجل: domain / priority / note / space_id / endTime
   - قواعد التحقق منها عند الكتابة.
   - (نهاية الموعد الفعلية getEffectiveEnd موجودة في organizer-schedule.js).

   دلالة الحقول (سجل قديم بلا هذه الحقول صحيح ومقروء كما هو):
   - غياب الحقل = "غير محدد". لا تُكتب قيم افتراضية على السجلات.
   - endTime  : "HH:MM". لا قيد أنه بعد time في نفس اليوم: إذا كانت endTime أصغر من أو تساوي time رقميًا
                فذلك يعني عبورًا لمنتصف الليل (النهاية في اليوم التالي)، والمدة تُحسب بحساب دائري (modulo 1440).
                القيد الوحيد: endTime !== time (المدتان 0 و24 ساعة ملتبستان وغير مسموحتين).
   - domain   : معرّف مجال بصيغة slug إنجليزية صغيرة (مثل car) — قابل للتوسع دون قائمة مغلقة.
   - priority : "low" | "normal" | "high".
   - note     : نص حتى 2000 حرف.
   - space_id : معرّف مساحة (للمشاركة لاحقًا)؛ غيابه = مساحة المستخدم الشخصية.
   ============================================================ */

export const PRIORITIES = Object.freeze(["low", "normal", "high"]);
export const NOTE_MAX_LENGTH = 2000;
export const KNOWN_DOMAINS = Object.freeze([
  "documents", "car", "bills", "family", "study", "work", "travel", "shopping", "occasions",
]);
export const DOMAIN_LABELS_AR = Object.freeze({
  documents: "وثائق", car: "سيارة", bills: "فواتير", family: "أسرة", study: "دراسة",
  work: "عمل", travel: "سفر", shopping: "تسوق", occasions: "مناسبات",
});
export const PRIORITY_LABELS_AR = Object.freeze({ low: "منخفضة", normal: "عادية", high: "عالية" });

/** الحقول التي تنتقل من جذر السلسلة إلى كل حدوث جديد. */
export const SERIES_INHERITED_FIELDS = Object.freeze(["endTime", "domain", "priority", "note", "space_id"]);

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DOMAIN_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SPACE_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export const timeToMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** تحقق من قيمة حقل واحد (null/undefined مقبول = غير محدد). يرمي organizer_invalid_field:<name>. */
export function assertValidField(name, value) {
  if (value === undefined || value === null) return;
  const bad = () => { throw new Error(`organizer_invalid_field:${name}: قيمة غير صالحة`); };
  switch (name) {
    case "endTime": if (typeof value !== "string" || !TIME_RE.test(value)) bad(); break;
    case "domain": if (typeof value !== "string" || !DOMAIN_RE.test(value)) bad(); break;
    case "priority": if (!PRIORITIES.includes(value)) bad(); break;
    case "note": if (typeof value !== "string" || value.length > NOTE_MAX_LENGTH) bad(); break;
    case "space_id": if (typeof value !== "string" || !SPACE_RE.test(value)) bad(); break;
    default: break;
  }
}

/**
 * مدة الموعد بالدقائق من time إلى endTime، بحساب دائري (لا قيد أنها بعده في نفس اليوم):
 * إذا كانت endTime <= time رقميًا فالمعنى عبور منتصف الليل، والمدة = بقية اليوم الأول + endTime.
 * لا نسمح بمدة صفر (endTime === time)، لأنها ملتبسة بين "بلا مدة" و"24 ساعة كاملة".
 * النتيجة دائمًا بين 1 و1439 دقيقة (أقل من 24 ساعة).
 */
export function durationMinutes(time, endTime) {
  return (((timeToMinutes(endTime) - timeToMinutes(time)) % 1440) + 1440) % 1440;
}

/** endTime يتطلب time، ولا يجوز أن يساويه (مدة ملتبسة). لا قيد أنه بعده في نفس اليوم؛ راجع durationMinutes. */
export function assertEndAfterStart(time, endTime) {
  if (endTime === undefined || endTime === null) return;
  if (!time || !TIME_RE.test(time)) {
    throw new Error("organizer_end_without_start: لا يمكن تحديد وقت نهاية دون وقت بداية");
  }
  if (endTime === time) {
    throw new Error("organizer_end_not_after_start: وقت النهاية لا يجوز أن يساوي وقت البداية (مدة ملتبسة)");
  }
}

/** يتحقق من الحقول الجديدة الموجودة في كائن (سجل كامل أو changes). لا يفحص ما لم يُذكر. */
export function validateExtraFields(obj) {
  if (!obj) return;
  for (const f of SERIES_INHERITED_FIELDS) if (has(obj, f)) assertValidField(f, obj[f]);
}

/** يبني كائن الحقول الجديدة من مدخلات مستخدم: يحذف القيم الفارغة، ويطبّع النص. */
export function pickExtraFields(input) {
  const out = {};
  if (!input) return out;
  for (const f of SERIES_INHERITED_FIELDS) {
    if (!has(input, f)) continue;
    let v = input[f];
    if (typeof v === "string") { v = v.trim(); if (v === "") v = null; }
    if (v === undefined || v === null) continue;
    assertValidField(f, v);
    out[f] = v;
  }
  return out;
}

/**
 * الحقول التي يرثها حدوث جديد من جذر السلسلة (قيم الجذر الأساسية، لا override الجذر: "هذه المرة فقط").
 * تسامح مع البيانات القديمة: قيمة غير صالحة تُهمَل بدل أن تكسر توليد الحدوث.
 */
export function pickInheritedFields(root) {
  const out = {};
  if (!root) return out;
  for (const f of SERIES_INHERITED_FIELDS) {
    const v = root[f];
    if (v === undefined || v === null) continue;
    try { assertValidField(f, v); } catch { continue; }
    if (f === "endTime") { try { assertEndAfterStart(root.time, v); } catch { continue; } }
    out[f] = v;
  }
  return out;
}

const minutesToTime = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

/**
 * حقول الجذر الجديد عند Series Split: يرث من الجذر القديم، وأي حقل مذكور في params يغلب (null = مسح).
 * إن تغيّر time دون endTime صريح: تُحفظ مدة الموعد الدائرية فتتحرك النهاية مع البداية تلقائيًا،
 * حتى لو كانت تعبر منتصف الليل (لا رفض ولا تدخل من المستخدم مطلوب). يرمي فقط عند قيمة صريحة غير صالحة.
 */
export function resolveSplitExtraFields(root, params, newTime) {
  const p = params || {};
  const out = {};
  for (const f of ["domain", "priority", "note", "space_id"]) {
    let v = has(p, f) ? p[f] : root[f];
    if (typeof v === "string") { v = v.trim(); if (v === "") v = null; }
    if (v === undefined || v === null) continue;
    if (has(p, f)) assertValidField(f, v);
    else { try { assertValidField(f, v); } catch { continue; } }
    out[f] = v;
  }
  if (has(p, "endTime")) {
    if (p.endTime !== undefined && p.endTime !== null) { assertValidField("endTime", p.endTime); out.endTime = p.endTime; }
  } else if (root.endTime != null) {
    let valid = true;
    try { assertValidField("endTime", root.endTime); assertEndAfterStart(root.time, root.endTime); } catch { valid = false; }
    if (valid) {
      if ((root.time || null) === (newTime || null)) out.endTime = root.endTime;
      else if (newTime) {
        const duration = durationMinutes(root.time, root.endTime);
        out.endTime = minutesToTime((timeToMinutes(newTime) + duration) % 1440);
      }
    }
  }
  assertEndAfterStart(newTime, out.endTime);
  return out;
}
