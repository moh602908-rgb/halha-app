/* ============================================================
   organizer-recurrence.js — Organizer Core: محرك التكرار الأساسي
   ============================================================
   نطاق هذا الملف: حساب التاريخ التالي لحدوث متكرر (يومي/أسبوعي/
   شهري بـAnchor Day)، وتوليد occurrence جديد عند الحاجة فقط —
   دون توليد لا نهائي، ودون منطق حالة/تأجيل/واجهة/إشعارات.

   العزل: يستورد فقط من organizer-crud.js (createOccurrence،
   getOccurrence، listOccurrencesByRootId). لا يصل مباشرة إلى
   IndexedDB، ولا يستورد أو يُستورَد من أي كود AI. لا شبكة.

   لا Store جديد للسلاسل: تعريف التكرار (recurrence) يُخزَّن داخل
   سجل الحدوث الأول للسلسلة فقط (حيث occ_key === root_id)، ضمن
   حقل recurrence الموجود أصلًا (placeholder) في نموذج البيانات.
   الحدوثات اللاحقة لا تحمل recurrence (تُقرَأ دائمًا من الجذر).

   بنية recurrence المعتمدة حرفيًا (لا حقول إضافية):
   {
     type: "daily" | "weekly" | "monthly",
     interval: 1,               // ثابت حاليًا
     weekdays: [0..6]?,         // للأسبوعي فقط (0=الأحد ... 6=السبت)
     anchor_day: number?,       // للشهري فقط — لا يتغيّر أبدًا
     series_end: "YYYY-MM-DD"?  // اختياري — لا نهاية إن غاب
   }

   Override/Exception: غير مُنفَّذة هنا عمدًا. عند إضافتها لاحقًا،
   نقطة الدمج الطبيعية هي داخل generateNextOccurrenceForSeries()
   قبل الإرجاع النهائي — لا بنية مُخترَعة لها هنا.
   ============================================================ */

import { createOccurrence, getOccurrence, listOccurrencesByRootId } from "./organizer-crud.js";

const ALLOWED_TYPES = new Set(["daily", "weekly", "monthly"]);

// ---------- أدوات تاريخ حتمية (UTC-only لتفادي DST، لا مكتبة خارجية) ----------

function parseISODate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function daysInMonth(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function addDaysISO(dateStr, days) {
  const d = parseISODate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

// ---------- حساب التاريخ التالي (دالة نقية — قابلة للاختبار مباشرة) ----------

/**
 * يحسب تاريخ الحدوث التالي فقط. لا يقرأ ولا يكتب أي شيء — حتمي بالكامل.
 * @param {string} currentDateStr تاريخ آخر حدوث فعلي بصيغة YYYY-MM-DD
 * @param {object} recurrence بنية التكرار المعتمدة أعلاه
 * @returns {string} التاريخ التالي بصيغة YYYY-MM-DD
 */
export function computeNextDate(currentDateStr, recurrence) {
  if (!recurrence || !ALLOWED_TYPES.has(recurrence.type)) {
    throw new Error(`organizer_invalid_recurrence_type: "${recurrence && recurrence.type}"`);
  }
  const interval = recurrence.interval || 1;

  if (recurrence.type === "daily") {
    return addDaysISO(currentDateStr, interval);
  }

  if (recurrence.type === "weekly") {
    if (!Array.isArray(recurrence.weekdays) || recurrence.weekdays.length === 0) {
      throw new Error("organizer_missing_weekdays: التكرار الأسبوعي يتطلب weekdays غير فارغة");
    }
    // interval=1 حاليًا فقط (بحسب القرار المعتمد) — نبحث عن أقرب يوم
    // أسبوع مطابق بعد التاريخ الحالي مباشرة، ضمن 7 أيام كحد أقصى.
    for (let step = 1; step <= 7; step++) {
      const candidate = addDaysISO(currentDateStr, step);
      const weekday = parseISODate(candidate).getUTCDay();
      if (recurrence.weekdays.includes(weekday)) {
        return candidate;
      }
    }
    throw new Error("organizer_weekly_no_match: لم يُعثر على يوم أسبوع مطابق ضمن 7 أيام");
  }

  if (recurrence.type === "monthly") {
    if (!Number.isInteger(recurrence.anchor_day) || recurrence.anchor_day < 1 || recurrence.anchor_day > 31) {
      throw new Error("organizer_missing_anchor_day: التكرار الشهري يتطلب anchor_day صحيح (1-31)");
    }
    const current = parseISODate(currentDateStr);
    let year = current.getUTCFullYear();
    let month = current.getUTCMonth() + 1 + interval; // 1..12، قد يتجاوز 12
    while (month > 12) { month -= 12; year += 1; }

    // anchor_day نفسه لا يتغيّر أبدًا — فقط اليوم الفعلي المولَّد يُقيَّد
    // بأقصى يوم متاح في ذلك الشهر (31 يناير → 28 فبراير → 31 مارس).
    const effectiveDay = Math.min(recurrence.anchor_day, daysInMonth(year, month));
    return toISODate(new Date(Date.UTC(year, month - 1, effectiveDay)));
  }
}

// ---------- إنشاء سلسلة جديدة (الحدوث الجذر يحمل قاعدة التكرار) ----------

/**
 * ينشئ الحدوث الأول لسلسلة متكررة. occ_key لهذا السجل = root_id نفسه
 * (يُستخدَم كعلامة "هذا هو الجذر الذي يحمل قاعدة التكرار").
 */
export async function createRecurringSeries({ root_id, title, itemType, time, date, recurrence }) {
  if (!root_id) throw new Error("organizer_missing_root_id: root_id مطلوب لإنشاء سلسلة");
  if (!recurrence || !ALLOWED_TYPES.has(recurrence.type)) {
    throw new Error(`organizer_invalid_recurrence_type: "${recurrence && recurrence.type}"`);
  }
  return createOccurrence({
    occ_key: root_id,
    root_id,
    title,
    itemType,
    time: time || null,
    date,
    status: "upcoming",
    recurrence,
  });
}

// ---------- توليد الحدوث التالي عند الحاجة فقط (لا توليد لا نهائي) ----------

/**
 * يولّد حدوث واحد تاليًا لسلسلة موجودة، إن لم يتجاوز series_end.
 * لا يُعدّل أي حدوث سابق — فقط يقرأ الجذر وآخر حدوث، ثم يُنشئ سجلًا جديدًا.
 * @returns {object|null} الحدوث الجديد، أو null إذا مُنِع بـseries_end
 */
export async function generateNextOccurrenceForSeries(root_id) {
  const root = await getOccurrence(root_id);
  if (!root) throw new Error(`organizer_series_not_found: لا سلسلة بالمعرّف ${root_id}`);
  const recurrence = root.recurrence;
  if (!recurrence || !ALLOWED_TYPES.has(recurrence.type)) {
    throw new Error(`organizer_invalid_recurrence_type: السلسلة ${root_id} بلا قاعدة تكرار صالحة`);
  }

  const existing = await listOccurrencesByRootId(root_id);
  // آخر تاريخ فعلي مولَّد في السلسلة (بما فيها الجذر نفسه) — أساس الحساب التالي.
  const latestDate = existing.reduce((max, occ) => (occ.date > max ? occ.date : max), root.date);

  const nextDate = computeNextDate(latestDate, recurrence);

  if (recurrence.series_end && nextDate > recurrence.series_end) {
    return null; // احترام series_end — لا توليد بعده
  }

  const newOccKey = `${root_id}::${nextDate}`;

  return createOccurrence({
    occ_key: newOccKey,
    root_id,
    title: root.title,
    itemType: root.itemType,
    time: root.time || null,
    date: nextDate,
    status: "upcoming",
    // recurrence غير مُضافة هنا عمدًا — القاعدة تبقى في الجذر فقط.
  });
}
