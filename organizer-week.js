/* ============================================================
   organizer-week.js — أسبوع من نفس استعلام النطاق الموجود (بلا كيان جديد)
   ============================================================
   يستخدم listOccurrencesInRange من organizer-schedule.js فقط. لا مخزن
   جديد، لا فهرس جديد. التنقل بين الأسابيع/الأيام هو تغيير from/to فقط.
   ============================================================ */

import { listOccurrencesInRange, getEffectiveEnd } from "./organizer-schedule.js";
import { getEffectiveSchedule } from "./organizer-postpone.js";

const p2 = (n) => String(n).padStart(2, "0");
const toDateStr = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** بداية الأسبوع (السبت، أول أيام الأسبوع في التقويم العربي المحلي الشائع) لتاريخ معيَّن. */
export function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = (d.getDay() + 1) % 7; // السبت=6 -> 0
  d.setDate(d.getDate() - diff);
  return d;
}

/**
 * أسبوع كامل (7 أيام من startOfWeek(date)) مقسَّمًا حسب اليوم، مرتبًا داخل كل يوم بـfire time.
 * { start, end, days: [{ date: "YYYY-MM-DD", occurrences: [...] }, × 7] }
 */
export async function getWeekView(date = new Date()) {
  const start = startOfWeek(date);
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const from = toDateStr(start), to = toDateStr(end);
  const occs = await listOccurrencesInRange(from, to);

  const byDate = new Map();
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    byDate.set(toDateStr(d), []);
  }
  for (const occ of occs) {
    const eff = getEffectiveSchedule(occ);
    if (byDate.has(eff.date)) byDate.get(eff.date).push(occ);
  }
  const days = [...byDate.entries()].map(([dateStr, list]) => ({
    date: dateStr,
    occurrences: list.sort((a, b) => {
      const ta = getEffectiveSchedule(a).time || "99:99", tb = getEffectiveSchedule(b).time || "99:99";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    }),
  }));
  return { start: from, end: to, days };
}

/** حالة خاصة من نفس الاستعلام: عناصر يوم واحد بالضبط (يُستخدَم لـ"غدًا" أيضًا). */
export async function getDayView(date) {
  const s = toDateStr(date);
  const occs = await listOccurrencesInRange(s, s);
  return occs.map((occ) => ({ occurrence: occ, effectiveEnd: getEffectiveEnd(occ) }));
}
