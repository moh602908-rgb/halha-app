/* ============================================================
   organizer-schedule.js — Organizer Core: النموذج الزمني المشتق + الاستعلام بنطاق تاريخي
   ============================================================
   - getEffectiveEnd(occ): نهاية الموعد الفعلية (مشتقة ولا تُخزَّن).
   - listOccurrencesInRange(from, to): الحدوثات التي تقع بداية جدولتها الفعلية في [from, to]
     باستخدام فهارس date / postpone.date / override.date (لا مسح كامل للمخزن).
   لا شبكة ولا أي اتصال بمسار AI. مصدر الحقيقة الوحيد: IndexedDB.
   ============================================================ */

import { openOrganizerDB } from "./organizer-db.js";
import { getEffectiveSchedule } from "./organizer-postpone.js";
import { timeToMinutes, durationMinutes } from "./organizer-model.js";

const OCCURRENCES_STORE = "occurrences";
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const p2 = (n) => String(n).padStart(2, "0");

function addMinutes(date, time, minutes) {
  const [y, m, d] = date.split("-").map(Number);
  const total = timeToMinutes(time) + minutes;
  const dt = new Date(Date.UTC(y, m - 1, d, 0, total)); // حساب تقويمي بلا تأثير DST
  return {
    date: `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`,
    time: `${p2(dt.getUTCHours())}:${p2(dt.getUTCMinutes())}`,
  };
}

/**
 * نهاية الموعد الفعلية {date,time} أو null. مشتقة ولا تُخزَّن:
 *  - المدة D = مسافة دائرية (durationMinutes، 1..1439 دقيقة) من بداية مرجعية إلى (override.endTime أو endTime)،
 *    حيث المرجع هو override.time إن وُجدت عند وجود override.endTime، وإلا time الأصلية. تشمل عبور منتصف الليل.
 *  - النهاية = البداية الفعلية (postpone > override > الأصل) + D.
 * لذلك التأجيل والتحرير يحافظان على المدة تلقائيًا، وقد تعبر النهاية منتصف الليل إلى اليوم التالي.
 * override.endTime = null يعني مسحًا صريحًا للنهاية. سجل قديم بمدة ملتبسة (endTime === time) يُعامل كبلا نهاية.
 */
export function getEffectiveEnd(occ) {
  if (!occ) return null;
  const eff = getEffectiveSchedule(occ);
  if (!eff || !eff.date || !eff.time) return null;
  const ov = occ.override && typeof occ.override === "object" ? occ.override : {};
  const hasOvEnd = has(ov, "endTime");
  const endRaw = hasOvEnd ? ov.endTime : occ.endTime;
  if (endRaw === undefined || endRaw === null || !TIME_RE.test(endRaw)) return null;
  const refStart = hasOvEnd && has(ov, "time") ? ov.time : occ.time;
  if (!refStart || !TIME_RE.test(refStart) || refStart === endRaw) return null;
  const duration = durationMinutes(refStart, endRaw);
  return addMinutes(eff.date, eff.time, duration);
}

function queryIndex(store, indexName, from, to) {
  return new Promise((resolve, reject) => {
    const req = store.index(indexName).getAll(IDBKeyRange.bound(from, to));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * الحدوثات (بما فيها المحذوفة ناعمًا — التصفية للمستدعي) التي تاريخها الفعلي بين from و to شاملين (YYYY-MM-DD).
 * المرشحات: date الأصلي أو postpone.date أو override.date داخل النطاق، ثم يُتحقق من التاريخ الفعلي
 * فيُستبعد ما نُقل خارج النطاق (وتُضم المنقولة إليه). النتيجة مرتبة بالتاريخ الفعلي ثم الوقت.
 */
export async function listOccurrencesInRange(from, to) {
  if (!DATE_RE.test(from || "") || !DATE_RE.test(to || "") || from > to) {
    throw new Error("organizer_invalid_range: نطاق تاريخ غير صالح");
  }
  const db = await openOrganizerDB();
  const tx = db.transaction(OCCURRENCES_STORE, "readonly");
  const store = tx.objectStore(OCCURRENCES_STORE);
  const parts = await Promise.all([
    queryIndex(store, "date_idx", from, to),
    queryIndex(store, "postpone_date_idx", from, to),
    queryIndex(store, "override_date_idx", from, to),
  ]);
  const byKey = new Map();
  for (const rec of parts.flat()) byKey.set(rec.occ_key, rec);
  const out = [];
  for (const rec of byKey.values()) {
    const eff = getEffectiveSchedule(rec);
    if (eff.date && eff.date >= from && eff.date <= to) out.push(rec);
  }
  out.sort((a, b) => {
    const ea = getEffectiveSchedule(a), eb = getEffectiveSchedule(b);
    if (ea.date !== eb.date) return ea.date < eb.date ? -1 : 1;
    const ta = ea.time || "99:99", tb = eb.time || "99:99";
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  return out;
}
