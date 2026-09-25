/* ============================================================
   organizer-today.js — Organizer Core: ترتيب بيانات Today فقط
   ============================================================
   طبقة مستقلة نقية (بلا IndexedDB، بلا قراءة، بلا كتابة) فوق
   الطبقات المعتمدة دون أي تعديل عليها: organizer-db.js /
   organizer-crud.js / organizer-recurrence.js / organizer-editing.js /
   organizer-series-split.js / organizer-postpone.js.

   الاستيراد: getEffectiveSchedule فقط من organizer-postpone.js —
   نفس منطق الأسبقية المعتمد هناك (postpone > override > الأصل)،
   دون إعادة تعريفه هنا. لا شبكة، لا AI، لا Gemini.

   النطاق (Today Data Ordering فقط، وليس Selection ولا UI):
   هذا الملف لا يستعلم من القاعدة ولا يقرر أي حدوث "يخص اليوم" —
   ذلك استعلام/اختيار منفصل خارج هذا النطاق (مثلًا: أي مجموعة من
   listOccurrencesByRootId مجمَّعة عبر عدة سلاسل من طبقة أعلى).
   يستقبل مصفوفة حدوثات جاهزة ويعيدها مُصنَّفة إلى ثلاث مجموعات
   بالترتيب المعتمد: Missed ثم Upcoming ثم Completed.

   التصنيف (Missed مشتقة وغير مخزَّنة — قرار معتمد سابقًا في
   Technical Spec Phase 1/2؛ لا يُعاد فتحه هنا):
   - مستثناة (override.excluded === true، أي حذف ناعم سابق سواء عبر
     Editing أو Series Split): تُستبعَد كليًا من الترتيب. هذا امتداد
     مباشر لسلوك "مستثنى = غير مرئي للمستخدم" المعتمد فعليًا في تلك
     الطبقات، وليس قرارًا جديدًا؛ يُذكَر صراحة في التقرير للتأكيد.
   - status === "completed" أو "not_completed": مجموعة Completed
     (كلا الحالتين النهائيتين تحت مجموعة واحدة، بحسب الترتيب المطلوب
     حرفيًا: Missed / Upcoming / Completed — ثلاث مجموعات فقط).
   - status === "upcoming" ولها وقت فعّال (date وtime)، ووقتها
     الفعّال قبل now: مجموعة Missed. (حدوث بلا وقت لا يصبح فائتًا
     أبدًا — Technical Spec Phase 2: "Task without time never becomes
     missed"، مطبَّق هنا حرفيًا).
   - غير ذلك (upcoming ووقتها الفعّال مستقبلًا، أو بلا وقت إطلاقًا):
     مجموعة Upcoming. مؤجَّل بوقت مستقبلي يقع هنا بحكم الأسبقية في
     getEffectiveSchedule دون أي منطق إضافي.

   الترتيب داخل كل مجموعة (من حقول موجودة أصلًا فقط: date/time
   الفعّالان وtitle وocc_key — بلا أي حقل جديد):
   - Upcoming: الموقَّت أولًا تصاعديًا (الأقرب أولًا)، ثم بلا وقت
     بعدهم؛ tie-breaker حتمي نهائي: title (مقارنة عربية محلية) ثم
     occ_key.
   - Missed: تصاعديًا (الأقدم فائتًا أولًا) — دائمًا لها وقت فعّال
     بحكم التصنيف أعلاه؛ نفس tie-breaker.
   - Completed: لا يوجد حقل "وقت إكمال" في نموذج البيانات الحالي
     (ولن يُضاف هنا)، فيُستخدَم الوقت/التاريخ المجدوَل الفعّال نفسه
     كأقرب بديل حتمي متاح، تنازليًا (الأحدث جدولًا أولًا)، وبلا وقت
     مجدوَل تذهب بعد ما له وقت؛ نفس tie-breaker.
   - عند تساوي الوقت الفعّال تمامًا في أي مجموعة: يُحسَم بـtie-breaker
     نفسه (title ثم occ_key)، وهو حتمي ومستقر عبر أي تشغيل.

   لا حد لطي Completed هنا (قرار غير نهائي بعد، خارج هذا النطاق).
   ============================================================ */

import { getEffectiveSchedule } from "./organizer-postpone.js";

const TERMINAL_STATUSES = new Set(["completed", "not_completed"]);

function isExcluded(occ) {
  return !!(occ && occ.override && occ.override.excluded === true);
}

/**
 * يصنّف حدوثًا واحدًا لمجموعة Today (دالة نقية — لا قراءة ولا كتابة).
 * @param {object} occ
 * @param {Date} [now]
 * @returns {"missed"|"upcoming"|"completed"|"excluded"}
 */
export function classifyTodayGroup(occ, now = new Date()) {
  if (!occ || typeof occ !== "object") {
    throw new Error("organizer_today_invalid_occurrence: سجل الحدوث مطلوب");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("organizer_today_invalid_now: now يجب أن يكون Date صالحًا");
  }
  if (isExcluded(occ)) return "excluded";
  if (TERMINAL_STATUSES.has(occ.status)) return "completed";
  if (occ.status !== "upcoming") {
    throw new Error(`organizer_today_invalid_status: "${occ.status}" حالة غير معروفة`);
  }
  const eff = getEffectiveSchedule(occ);
  if (eff.date && eff.time) {
    const [y, m, d] = eff.date.split("-").map(Number);
    const [hh, mm] = eff.time.split(":").map(Number);
    const effMs = new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
    if (effMs < now.getTime()) return "missed";
  }
  return "upcoming";
}

// مفتاح مقارنة زمني نصّي من التاريخ/الوقت الفعّالين فقط (YYYY-MM-DDTHH:MM
// بعرض ثابت، فتُقارَن lexicographically بأمان)؛ null يعني "بلا وقت مجدوَل".
function scheduleKey(occ) {
  const eff = getEffectiveSchedule(occ);
  if (!eff.date) return null;
  return `${eff.date}T${eff.time || "00:00"}`;
}

function tieBreak(a, b) {
  const byTitle = (a.title || "").localeCompare(b.title || "", "ar");
  if (byTitle !== 0) return byTitle;
  return a.occ_key < b.occ_key ? -1 : a.occ_key > b.occ_key ? 1 : 0;
}

function sortUpcoming(list) {
  const timed = [];
  const untimed = [];
  for (const occ of list) {
    const eff = getEffectiveSchedule(occ);
    (eff.date && eff.time ? timed : untimed).push(occ);
  }
  timed.sort((a, b) => {
    const ka = scheduleKey(a), kb = scheduleKey(b);
    return ka !== kb ? (ka < kb ? -1 : 1) : tieBreak(a, b);
  });
  untimed.sort(tieBreak);
  return [...timed, ...untimed];
}

function sortMissed(list) {
  return [...list].sort((a, b) => {
    const ka = scheduleKey(a), kb = scheduleKey(b); // دائمًا غير null هنا (بحكم التصنيف)
    return ka !== kb ? (ka < kb ? -1 : 1) : tieBreak(a, b);
  });
}

function sortCompleted(list) {
  return [...list].sort((a, b) => {
    const ka = scheduleKey(a), kb = scheduleKey(b);
    if (ka === null && kb === null) return tieBreak(a, b);
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka !== kb ? (ka > kb ? -1 : 1) : tieBreak(a, b);
  });
}

/**
 * يرتّب مجموعة حدوثات جاهزة (لا يقرأ من IndexedDB). يستبعد المستثناة
 * (override.excluded === true) من كل المجموعات. لا يُعدِّل أي سجل
 * ممرَّر إليه (لا تحويل، لا نسخ عميق — الترتيب فقط).
 * @param {Array<object>} occurrences
 * @param {Date} [now]
 * @returns {{missed: object[], upcoming: object[], completed: object[], ordered: object[]}}
 */
export function orderTodayOccurrences(occurrences, now = new Date()) {
  if (!Array.isArray(occurrences)) {
    throw new Error("organizer_today_invalid_input: occurrences يجب أن تكون مصفوفة");
  }
  const missed = [];
  const upcoming = [];
  const completed = [];
  for (const occ of occurrences) {
    const group = classifyTodayGroup(occ, now);
    if (group === "missed") missed.push(occ);
    else if (group === "upcoming") upcoming.push(occ);
    else if (group === "completed") completed.push(occ);
    // "excluded" تُستبعَد تمامًا من كل المجموعات
  }
  const sortedMissed = sortMissed(missed);
  const sortedUpcoming = sortUpcoming(upcoming);
  const sortedCompleted = sortCompleted(completed);
  return {
    missed: sortedMissed,
    upcoming: sortedUpcoming,
    completed: sortedCompleted,
    ordered: [...sortedMissed, ...sortedUpcoming, ...sortedCompleted],
  };
}
