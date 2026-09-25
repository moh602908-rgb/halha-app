import {
  createOccurrence, getOccurrence, listOccurrencesByRootId, updateOccurrence,
} from "./organizer-crud.js";
import { createRecurringSeries, generateNextOccurrenceForSeries } from "./organizer-recurrence.js";
import { deleteOccurrence as softDelete, editOccurrenceContent } from "./organizer-editing.js";
import { splitSeriesFromDate } from "./organizer-series-split.js";
import { postponeOccurrence as postponeRaw, quickPostpone, getEffectiveSchedule } from "./organizer-postpone.js";

const RESULTS = [];
let uid = 0;
const nid = (p) => `${p}_${Date.now().toString(36)}_${++uid}`;

function check(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg || "not equal"}\n  actual:   ${x}\n  expected: ${y}`);
}
async function rejects(fn, code) {
  try { await fn(); } catch (e) {
    check(String(e.message).includes(code), `رُفض بخطأ غير متوقع: ${e.message} (المتوقع ${code})`);
    return;
  }
  throw new Error(`كان يجب أن يُرفَض بـ ${code}`);
}
async function t(group, id, name, fn) {
  try { await fn(); RESULTS.push({ group, id, name, pass: true }); }
  catch (e) { RESULTS.push({ group, id, name, pass: false, detail: String(e.message || e) }); }
}

// ---------- أدوات ----------
const clone = (x) => JSON.parse(JSON.stringify(x));
const byDate = (arr) => [...arr].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
const list = async (id) => byDate(await listOccurrencesByRootId(id));
const keyFor = (id, date) => `${id}::${date}`;
const p2 = (n) => String(n).padStart(2, "0");
// ⚠ أداة اختبار محلية فقط (ليست جزءًا من الطبقة): اشتقاق missed من الجدولة الفعّالة.
const isMissedLocal = (occ, now) => {
  const s = getEffectiveSchedule(occ);
  if (!s.date || !s.time) return false;
  const nowStr = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}T${p2(now.getHours())}:${p2(now.getMinutes())}`;
  return `${s.date}T${s.time}` < nowStr;
};
const NOW = new Date(2026, 8, 24, 12, 0, 0); // 2026-09-24 12:00 محلي
// ساعة الاختبار الافتراضية لـCustom (مبكرة، فكل أهداف 2026 اللاحقة مستقبلية) — حقن صريح بدل الاعتماد على ساعة الجهاز.
const CLOCK = new Date(2026, 0, 1, 0, 0, 0);
const postponeOccurrence = (k, tg, now = CLOCK) => postponeRaw(k, tg, now);

async function makeStandalone({ date = "2026-10-05", time = "09:00", status = "upcoming", extra = {} } = {}) {
  const k = nid("P");
  await createOccurrence({ occ_key: k, root_id: k, title: "دواء", itemType: "reminder", date, time, status, ...extra });
  return k;
}
async function makeSeries(id, count = 4, date = "2026-10-01", rec = { type: "daily", interval: 1 }) {
  await createRecurringSeries({ root_id: id, title: "متكرر", itemType: "reminder", time: "09:00", date, recurrence: rec });
  for (let i = 0; i < count; i++) await generateNextOccurrenceForSeries(id);
  return list(id);
}
const strip = (o, ...keys) => { const c = clone(o); keys.forEach((k) => delete c[k]); return c; };

// ================== 1) Custom Postpone: upcoming ==================
await t("Postpone", "P1", "postpone upcoming (Custom): الوقت الجديد محفوظ، السجل الأصلي لم يُمَس", async () => {
  const k = await makeStandalone();
  const before = clone(await getOccurrence(k));
  const r = await postponeOccurrence(k, { date: "2026-10-06", time: "14:30" });
  const after = await getOccurrence(k);
  eq(after.postpone, { date: "2026-10-06", time: "14:30" });
  eq(strip(after, "postpone"), before, "تغيّر حقل آخر غير postpone");
  eq(r.effective, { date: "2026-10-06", time: "14:30" });
  eq(r.previous_effective, { date: "2026-10-05", time: "09:00" });
  eq(getEffectiveSchedule(after), { date: "2026-10-06", time: "14:30", source: "postpone" });
});

// ================== 2) postpone missed ==================
await t("Postpone", "P2", "postpone missed: حدوث فائت (مشتق) يُؤجَّل ويصبح غير فائت بالوقت الجديد", async () => {
  const k = await makeStandalone({ date: "2026-09-20", time: "08:00" });
  check(isMissedLocal(await getOccurrence(k), NOW), "الافتراض: الحدوث فائت قبل التأجيل");
  await postponeOccurrence(k, { date: "2026-09-25", time: "09:00" });
  const after = await getOccurrence(k);
  eq(after.status, "upcoming");
  check(!isMissedLocal(after, NOW), "ما زال فائتًا بعد التأجيل");
});

// ================== 3-4) رفض الحالات النهائية ==================
for (const [id, status] of [["P3", "completed"], ["P4", "not_completed"]]) {
  await t("Postpone", id, `رفض postpone لـ${status} دون أي تغيير (Custom وQuick)`, async () => {
    const k = await makeStandalone({ status });
    const before = clone(await getOccurrence(k));
    await rejects(() => postponeOccurrence(k, { date: "2026-10-06", time: "10:00" }), "organizer_postpone_terminal_status");
    await rejects(() => quickPostpone(k, { amount: 1, unit: "hours" }, NOW), "organizer_postpone_terminal_status");
    eq(await getOccurrence(k), before);
    check(!("postpone" in (await getOccurrence(k))), "كُتب postpone رغم الرفض");
  });
}

// ================== 5) رفض المستثناة ==================
await t("Postpone", "P5", "رفض occurrence المستثناة (soft delete، ومستثناة بالانقسام)، دون أي تغيير", async () => {
  const id = nid("P5");
  await makeSeries(id, 3);
  const k = keyFor(id, "2026-10-02");
  await softDelete(k);
  const before = clone(await getOccurrence(k));
  await rejects(() => postponeOccurrence(k, { date: "2026-10-09", time: "10:00" }), "organizer_postpone_excluded");
  await rejects(() => quickPostpone(k, { amount: 10, unit: "minutes" }, NOW), "organizer_postpone_excluded");
  eq(await getOccurrence(k), before);
  // مستثناة بواسطة Series Split
  const id2 = nid("P5s"), id2n = nid("P5n");
  await makeSeries(id2, 5);
  await splitSeriesFromDate({ root_id: id2, split_date: "2026-10-04", new_root_id: id2n });
  await rejects(() => postponeOccurrence(keyFor(id2, "2026-10-05"), { date: "2026-10-30", time: "10:00" }), "organizer_postpone_excluded");
});

// ================== 6) root_id والسلسلة ==================
await t("Postpone", "P6", "root_id والسلسلة دون تغيير؛ التوليد التالي لا يتأثر؛ حدوثات أخرى لم تُمَس", async () => {
  const id = nid("P6");
  await makeSeries(id, 4); // 10-01 .. 10-05
  const before = await list(id);
  const target = keyFor(id, "2026-10-03");
  await postponeOccurrence(target, { date: "2026-12-31", time: "08:00" });
  const after = await list(id);
  eq(after.length, before.length, "تغيّر عدد سجلات السلسلة");
  eq(after.filter((o) => o.occ_key !== target), before.filter((o) => o.occ_key !== target), "حدوث آخر تغيّر");
  const p = after.find((o) => o.occ_key === target);
  eq([p.root_id, p.occ_key, p.date, p.time], [id, target, "2026-10-03", "09:00"]);
  eq(strip(p, "postpone"), before.find((o) => o.occ_key === target));
  eq((await getOccurrence(id)).recurrence, { type: "daily", interval: 1 });
  eq((await generateNextOccurrenceForSeries(id)).date, "2026-10-06", "التأجيل غيّر التوليد");
});

// ================== 7) بقاء Override ==================
await t("Postpone", "P7", "Override السابق محفوظ بعد التأجيل (مرة ومرتين)، والوقت الفعّال = وقت التأجيل", async () => {
  const id = nid("P7");
  await makeSeries(id, 3);
  const k = keyFor(id, "2026-10-03");
  await editOccurrenceContent(k, { title: "عنوان معدّل", time: "17:30" });
  const ov = clone((await getOccurrence(k)).override);
  eq(getEffectiveSchedule(await getOccurrence(k)), { date: "2026-10-03", time: "17:30", source: "override" });
  await postponeOccurrence(k, { date: "2026-10-10", time: "08:00" });
  let r = await getOccurrence(k);
  eq(r.override, ov);
  eq(getEffectiveSchedule(r), { date: "2026-10-10", time: "08:00", source: "postpone" });
  await postponeOccurrence(k, { date: "2026-10-12", time: "21:15" });
  r = await getOccurrence(k);
  eq(r.override, ov);
  eq(getEffectiveSchedule(r), { date: "2026-10-12", time: "21:15", source: "postpone" });
  eq(r.status, "upcoming");
});

// ================== 8) الحالة upcoming ==================
await t("Postpone", "P8", "الحالة تبقى upcoming (لا postponed مخزَّنة)؛ يمكن بعدها إكمالها ثم يُرفض تأجيلها", async () => {
  const k = await makeStandalone();
  const r = await postponeOccurrence(k, { date: "2026-10-07", time: "10:00" });
  eq(r.status, "upcoming");
  eq((await getOccurrence(k)).status, "upcoming");
  await rejects(() => updateOccurrence(k, { status: "postponed" }), "organizer_invalid_status");
  await updateOccurrence(k, { status: "completed" });
  eq((await getOccurrence(k)).postpone, { date: "2026-10-07", time: "10:00" }, "postpone فُقد عند الإكمال");
  await rejects(() => postponeOccurrence(k, { date: "2026-10-08", time: "10:00" }), "organizer_postpone_terminal_status");
});

// ================== 9) صحة التاريخ/الوقت ==================
await t("Postpone", "P9", "التاريخ/الوقت الجديدان يُحفظان بدقة (حدود 00:00 و23:59 وكبيسة) ويُرفض الخاطئ دون تغيير", async () => {
  const k = await makeStandalone();
  for (const [date, time] of [["2028-02-29", "00:00"], ["2026-12-31", "23:59"], ["2026-01-01", "07:05"]]) {
    await postponeOccurrence(k, { date, time });
    eq((await getOccurrence(k)).postpone, { date, time });
  }
  const before = clone(await getOccurrence(k));
  const bad = [
    [{ date: "2026-02-30", time: "10:00" }, "invalid_date"], [{ date: "2027-02-29", time: "10:00" }, "invalid_date"],
    [{ date: "2026-1-1", time: "10:00" }, "invalid_date"], [{ date: "10/10/2026", time: "10:00" }, "invalid_date"],
    [{ time: "10:00" }, "invalid_date"],
    [{ date: "2026-10-10", time: "24:00" }, "invalid_time"], [{ date: "2026-10-10", time: "9:05" }, "invalid_time"],
    [{ date: "2026-10-10", time: "10:60" }, "invalid_time"], [{ date: "2026-10-10" }, "invalid_time"],
    [{ date: "2026-10-10", time: null }, "invalid_time"], [undefined, "invalid_date"],
  ];
  for (const [tgt, code] of bad) await rejects(() => postponeOccurrence(k, tgt), `organizer_postpone_${code}`);
  eq(await getOccurrence(k), before, "تغيّر السجل بعد رفض");
});

// ================== 10) Quick Postpone ==================
await t("Quick", "Q1", "Quick minutes: الآن + 10 دقائق (الثواني تُسقَط)", async () => {
  const k = await makeStandalone();
  const r = await quickPostpone(k, { amount: 10, unit: "minutes" }, new Date(2026, 9, 5, 10, 0, 45));
  eq(r.effective, { date: "2026-10-05", time: "10:10" });
  eq((await getOccurrence(k)).postpone, { date: "2026-10-05", time: "10:10" });
});
await t("Quick", "Q2", "Quick hours عبر منتصف الليل: 23:30 + ساعة = اليوم التالي 00:30", async () => {
  const k = await makeStandalone();
  const r = await quickPostpone(k, { amount: 1, unit: "hours" }, new Date(2026, 9, 5, 23, 30, 0));
  eq(r.effective, { date: "2026-10-06", time: "00:30" });
});
await t("Quick", "Q3", "Quick hours عبر تغيير التوقيت الصيفي (NY): 01:30 + ساعة = 03:30", async () => {
  check(Intl.DateTimeFormat().resolvedOptions().timeZone === "America/New_York", "المنطقة الزمنية للاختبار ليست America/New_York");
  const k = await makeStandalone();
  const r = await quickPostpone(k, { amount: 1, unit: "hours" }, new Date(2026, 2, 8, 1, 30, 0));
  eq(r.effective, { date: "2026-03-08", time: "03:30" });
});
await t("Quick", "Q4", "Quick days: التاريخ = اليوم + n مع إبقاء الوقت الفعّال (Override ثم postpone سابق) وعبر DST/نهاية الشهر", async () => {
  const id = nid("Q4");
  await makeSeries(id, 2);
  const k = keyFor(id, "2026-10-02");
  await editOccurrenceContent(k, { time: "17:30" });
  let r = await quickPostpone(k, { amount: 1, unit: "days" }, new Date(2026, 2, 7, 10, 0, 0));
  eq(r.effective, { date: "2026-03-08", time: "17:30" }); // الوقت من override، وعبر بدء DST
  await postponeOccurrence(k, { date: "2026-10-20", time: "06:45" });
  r = await quickPostpone(k, { amount: 3, unit: "days" }, new Date(2026, 9, 30, 8, 0, 0));
  eq(r.effective, { date: "2026-11-02", time: "06:45" }); // الوقت من postpone السابق
  eq((await getOccurrence(k)).override, { time: "17:30" }, "override تغيّر");
});
await t("Quick", "Q5", "Quick days لحدوث بلا وقت: يبقى بلا وقت", async () => {
  const k = await makeStandalone({ time: null });
  const r = await quickPostpone(k, { amount: 2, unit: "days" }, new Date(2026, 9, 5, 10, 0, 0));
  eq(r.effective, { date: "2026-10-07", time: null });
});
await t("Quick", "Q6", "Quick على حدوث فائت (missed): نسبي للآن فيصبح مستقبليًا وغير فائت", async () => {
  const k = await makeStandalone({ date: "2026-09-01", time: "08:00" });
  check(isMissedLocal(await getOccurrence(k), NOW), "الافتراض: فائت");
  await quickPostpone(k, { amount: 2, unit: "hours" }, NOW);
  const a = await getOccurrence(k);
  eq(a.postpone, { date: "2026-09-24", time: "14:00" });
  check(!isMissedLocal(a, NOW) && a.status === "upcoming");
});
await t("Quick", "Q7", "Quick: مدخلات خاطئة (مقدار/وحدة/now) ⇒ رفض دون أي تغيير", async () => {
  const k = await makeStandalone();
  const before = clone(await getOccurrence(k));
  for (const amount of [0, -5, 1.5, "10", NaN, undefined]) {
    await rejects(() => quickPostpone(k, { amount, unit: "minutes" }, NOW), "organizer_postpone_invalid_amount");
  }
  await rejects(() => quickPostpone(k, { amount: 1, unit: "weeks" }, NOW), "organizer_postpone_invalid_unit");
  await rejects(() => quickPostpone(k, { amount: 1, unit: "hours" }, new Date("x")), "organizer_postpone_invalid_now");
  await rejects(() => quickPostpone(k, { amount: 1, unit: "hours" }, "2026-01-01"), "organizer_postpone_invalid_now");
  eq(await getOccurrence(k), before);
});

// ================== الجدولة الفعّالة ==================
await t("Postpone", "E1", "getEffectiveSchedule: الأسبقية postpone > override > الأصل (وoverride جزئي)", async () => {
  eq(getEffectiveSchedule({ date: "2026-10-01", time: "09:00" }), { date: "2026-10-01", time: "09:00", source: "original" });
  eq(getEffectiveSchedule({ date: "2026-10-01", time: "09:00", override: { title: "x" } }), { date: "2026-10-01", time: "09:00", source: "original" });
  eq(getEffectiveSchedule({ date: "2026-10-01", time: "09:00", override: { time: "18:00" } }), { date: "2026-10-01", time: "18:00", source: "override" });
  eq(getEffectiveSchedule({ date: "2026-10-01", time: "09:00", override: { date: "2026-10-09", time: "18:00" } }), { date: "2026-10-09", time: "18:00", source: "override" });
  eq(getEffectiveSchedule({ date: "2026-10-01", time: "09:00", override: { time: "18:00" }, postpone: { date: "2026-11-01", time: "07:00" } }), { date: "2026-11-01", time: "07:00", source: "postpone" });
  eq(getEffectiveSchedule({ date: "2026-10-01", time: null }), { date: "2026-10-01", time: null, source: "original" });
  await rejects(async () => getEffectiveSchedule(null), "organizer_postpone_invalid_occurrence");
});
await t("Postpone", "E2", "تأجيل متكرر: الأخير يستبدل السابق فقط، والأصل وoverride لا يتغيران", async () => {
  const k = await makeStandalone({ extra: { override: { title: "عنوان" } } });
  const base = clone(await getOccurrence(k));
  await postponeOccurrence(k, { date: "2026-10-06", time: "10:00" });
  await quickPostpone(k, { amount: 30, unit: "minutes" }, new Date(2026, 9, 6, 9, 0, 0));
  const r = await getOccurrence(k);
  eq(r.postpone, { date: "2026-10-06", time: "09:30" });
  eq(strip(r, "postpone"), base);
});
await t("Postpone", "E3", "occ_key غير موجود/فارغ ⇒ رفض", async () => {
  await rejects(() => postponeOccurrence("no-such", { date: "2026-10-06", time: "10:00" }), "organizer_not_found");
  await rejects(() => postponeOccurrence("", { date: "2026-10-06", time: "10:00" }), "organizer_missing_occ_key");
  await rejects(() => quickPostpone(undefined, { amount: 1, unit: "hours" }, NOW), "organizer_missing_occ_key");
});
await t("Postpone", "E4", "تأجيل سجل الجذر (الحامل لـrecurrence): recurrence وroot_id وseries_end لا تتغير", async () => {
  const id = nid("E4");
  await createRecurringSeries({ root_id: id, title: "x", itemType: "reminder", time: "09:00", date: "2026-10-01",
    recurrence: { type: "weekly", weekdays: [1, 3], interval: 1, series_end: "2026-12-31" } });
  const before = clone(await getOccurrence(id));
  await postponeOccurrence(id, { date: "2026-10-03", time: "11:00" });
  const after = await getOccurrence(id);
  eq(strip(after, "postpone"), before);
  eq((await generateNextOccurrenceForSeries(id)).date, "2026-10-05"); // Mon بعد 10-01 (الأصل)
});

// ================== تكامل مع Editing / Series Split ==================
await t("تكامل", "I1", "Editing بعد التأجيل: الحذف الناعم يحفظ postpone ثم يُرفض أي تأجيل لاحق", async () => {
  const id = nid("I1");
  await makeSeries(id, 2);
  const k = keyFor(id, "2026-10-02");
  await postponeOccurrence(k, { date: "2026-10-09", time: "10:00" });
  await softDelete(k);
  const r = await getOccurrence(k);
  eq(r.postpone, { date: "2026-10-09", time: "10:00" });
  eq(r.override, { excluded: true });
  await rejects(() => postponeOccurrence(k, { date: "2026-10-10", time: "10:00" }), "organizer_postpone_excluded");
});
await t("تكامل", "I2", "Editing بعد التأجيل: تعديل title فقط يحفظ postpone ويبقى الوقت الفعّال للتأجيل", async () => {
  const id = nid("I2");
  await makeSeries(id, 2);
  const k = keyFor(id, "2026-10-02");
  await postponeOccurrence(k, { date: "2026-10-09", time: "10:00" });
  await editOccurrenceContent(k, { title: "جديد" });
  const r = await getOccurrence(k);
  eq(r.postpone, { date: "2026-10-09", time: "10:00" });
  eq(r.override, { title: "جديد" });
  eq(getEffectiveSchedule(r), { date: "2026-10-09", time: "10:00", source: "postpone" });
});
await t("تكامل", "I3", "Series Split: حدوث مؤجَّل قبل D لا يتغير، ويمكن تأجيل جذر R2 الجديد", async () => {
  const R1 = nid("I3"), R2 = nid("I3n");
  await makeSeries(R1, 5);
  const k = keyFor(R1, "2026-10-02");
  await postponeOccurrence(k, { date: "2026-10-20", time: "09:00" });
  const snap = clone(await getOccurrence(k));
  await splitSeriesFromDate({ root_id: R1, split_date: "2026-10-04", new_root_id: R2 });
  eq(await getOccurrence(k), snap);
  await postponeOccurrence(R2, { date: "2026-10-06", time: "12:00" });
  eq((await getOccurrence(R2)).root_id, R2);
});
await t("تكامل (مشكلة مكتشفة)", "I4", "Series Split: حدوث مؤجَّل تاريخه >= D يجب ألا يُستثنى تلقائيًا (اختيار صريح من المستخدم)", async () => {
  const R1 = nid("I4"), R2 = nid("I4n");
  await makeSeries(R1, 5); // 10-01 .. 10-06
  const k = keyFor(R1, "2026-10-05");
  await postponeOccurrence(k, { date: "2026-10-25", time: "09:00" });
  const r = await splitSeriesFromDate({ root_id: R1, split_date: "2026-10-04", new_root_id: R2 });
  const after = await getOccurrence(k);
  check(!(after.override && after.override.excluded === true) && r.retained_occ_keys.includes(k),
    `الحدوث المؤجَّل استُثني تلقائيًا: override=${JSON.stringify(after.override)}, retained=${JSON.stringify(r.retained_occ_keys)}`);
});


// ================== إصلاح 1: I5 — Series Split لا يستثني المؤجَّل ولا يغيّر بقية السلوك ==================
await t("تكامل (مشكلة مكتشفة)", "I5", "Series Split: المؤجَّل >= D يبقى بكل بياناته حرفيًا، وبقية Placeholders ما زالت تُستثنى", async () => {
  const R1 = nid("I5"), R2 = nid("I5n");
  await makeSeries(R1, 5); // 10-01 .. 10-06
  const k = keyFor(R1, "2026-10-05");
  await postponeOccurrence(k, { date: "2026-10-25", time: "09:00" });
  const snap = clone(await getOccurrence(k));
  const r = await splitSeriesFromDate({ root_id: R1, split_date: "2026-10-04", new_root_id: R2 });
  eq(await getOccurrence(k), snap, "سجل المؤجَّل تغيّر");
  eq(r.retained_occ_keys, [k]);
  eq(r.excluded_occ_keys.sort(), [keyFor(R1, "2026-10-04"), keyFor(R1, "2026-10-06")]);
  eq((await getOccurrence(k)).postpone, { date: "2026-10-25", time: "09:00" });
});

// ================== إصلاح 2: Edit بعد Postpone ==================
async function editScenario(changes, { withOverride = true } = {}) {
  const id = nid("G");
  await makeSeries(id, 3); // 10-01 .. 10-04
  const k = keyFor(id, "2026-10-03");
  if (withOverride) await editOccurrenceContent(k, { title: "عنوان سابق" });
  await postponeOccurrence(k, { date: "2026-10-20", time: "18:00" });
  const before = await list(id);
  const beforeTarget = clone(await getOccurrence(k));
  const rootBefore = clone(await getOccurrence(id));
  await editOccurrenceContent(k, changes);
  return { id, k, before, beforeTarget, rootBefore, after: await list(id), rec: await getOccurrence(k) };
}
const untouchedCheck = (sc) => {
  eq(sc.after.filter((o) => o.occ_key !== sc.k), sc.before.filter((o) => o.occ_key !== sc.k), "تغيّرت بقية السلسلة");
  eq([sc.rec.root_id, sc.rec.occ_key, sc.rec.status, sc.rec.date, sc.rec.time],
    [sc.beforeTarget.root_id, sc.beforeTarget.occ_key, "upcoming", "2026-10-03", "09:00"]);
};
await t("Edit بعد Postpone", "G1", "Edit date بعد Postpone: postpone يُحذف فعليًا، override يبقى، الوقت الفعّال = override", async () => {
  const sc = await editScenario({ date: "2026-10-15" });
  check(!("postpone" in sc.rec), "postpone لم يُحذف");
  eq(sc.rec.override, { title: "عنوان سابق", date: "2026-10-15" });
  eq(getEffectiveSchedule(sc.rec), { date: "2026-10-15", time: "09:00", source: "override" });
  untouchedCheck(sc);
  eq(await getOccurrence(sc.id), sc.rootBefore, "الجذر/recurrence تغيّر");
});
await t("Edit بعد Postpone", "G2", "Edit time بعد Postpone: postpone يُحذف فعليًا، override يبقى، الوقت الفعّال = override", async () => {
  const sc = await editScenario({ time: "21:45" });
  check(!("postpone" in sc.rec), "postpone لم يُحذف");
  eq(sc.rec.override, { title: "عنوان سابق", time: "21:45" });
  eq(getEffectiveSchedule(sc.rec), { date: "2026-10-03", time: "21:45", source: "override" });
  untouchedCheck(sc);
  eq(await getOccurrence(sc.id), sc.rootBefore);
});
await t("Edit بعد Postpone", "G3", "Edit title فقط بعد Postpone: postpone يبقى والوقت الفعّال = وقت التأجيل", async () => {
  const sc = await editScenario({ title: "عنوان أحدث" });
  eq(sc.rec.postpone, { date: "2026-10-20", time: "18:00" });
  eq(sc.rec.override, { title: "عنوان أحدث" });
  eq(getEffectiveSchedule(sc.rec), { date: "2026-10-20", time: "18:00", source: "postpone" });
  untouchedCheck(sc);
});
await t("Edit بعد Postpone", "G4", "Edit title + date/time معًا: postpone يُحذف وكل الحقول تدخل override", async () => {
  const sc = await editScenario({ title: "ت", date: "2026-11-01", time: "07:00" }, { withOverride: false });
  check(!("postpone" in sc.rec));
  eq(sc.rec.override, { title: "ت", date: "2026-11-01", time: "07:00" });
  eq(getEffectiveSchedule(sc.rec), { date: "2026-11-01", time: "07:00", source: "override" });
  untouchedCheck(sc);
});
await t("Edit بعد Postpone", "G5", "تعديل date/time لسجل الجذر المؤجَّل: recurrence وroot_id وseries_end لا تتغير", async () => {
  const id = nid("G5");
  await createRecurringSeries({ root_id: id, title: "x", itemType: "reminder", time: "09:00", date: "2026-10-01",
    recurrence: { type: "weekly", weekdays: [1, 3], interval: 1, series_end: "2026-12-31" } });
  const before = clone(await getOccurrence(id));
  await postponeOccurrence(id, { date: "2026-10-03", time: "11:00" });
  await editOccurrenceContent(id, { time: "12:30" });
  const r = await getOccurrence(id);
  check(!("postpone" in r));
  eq(r.recurrence, before.recurrence);
  eq([r.root_id, r.occ_key, r.date, r.time, r.status], [id, id, "2026-10-01", "09:00", "upcoming"]);
  eq(r.override, { time: "12:30" });
});
await t("Edit بعد Postpone", "G6", "بعد حذف postpone بالتعديل: يمكن التأجيل مجددًا، وتعديل date/time لسجل بلا postpone يعمل كما كان", async () => {
  const sc = await editScenario({ time: "21:45" });
  await postponeOccurrence(sc.k, { date: "2026-10-30", time: "10:00" });
  const r = await getOccurrence(sc.k);
  eq(r.postpone, { date: "2026-10-30", time: "10:00" });
  eq(r.override, { title: "عنوان سابق", time: "21:45" });
  const id = nid("G6b");
  await makeSeries(id, 2);
  const k2 = keyFor(id, "2026-10-02");
  const r2 = await editOccurrenceContent(k2, { date: "2026-10-09" }); // بلا postpone: المسار القديم
  eq(r2.override, { date: "2026-10-09" });
  check(!("postpone" in r2));
});

// ================== إصلاح 3: لا تأجيل إلى الماضي أو اللحظة الحالية ==================
await t("لا ماضي", "T1", "Custom في الماضي ⇒ رفض organizer_postpone_not_in_future دون تغيير (ماضٍ بعيد، ويوم سابق، ونفس اليوم قبل الآن)", async () => {
  const k = await makeStandalone();
  const before = clone(await getOccurrence(k));
  for (const tg of [{ date: "2020-01-01", time: "08:00" }, { date: "2026-09-20", time: "08:00" }, { date: "2026-09-24", time: "11:59" }]) {
    await rejects(() => postponeRaw(k, tg, NOW), "organizer_postpone_not_in_future");
  }
  eq(await getOccurrence(k), before);
  check(!("postpone" in (await getOccurrence(k))));
});
await t("لا ماضي", "T2", "Custom مساوٍ للحظة التنفيذ ⇒ رفض دون تغيير؛ والدقيقة التالية مقبولة", async () => {
  const k = await makeStandalone();
  const before = clone(await getOccurrence(k));
  const exact = new Date(2026, 8, 24, 12, 0, 0, 0);
  await rejects(() => postponeRaw(k, { date: "2026-09-24", time: "12:00" }, exact), "organizer_postpone_not_in_future");
  await rejects(() => postponeRaw(k, { date: "2026-09-24", time: "12:00" }, new Date(2026, 8, 24, 12, 0, 0, 1)), "organizer_postpone_not_in_future");
  eq(await getOccurrence(k), before);
  await postponeRaw(k, { date: "2026-09-24", time: "12:01" }, exact);
  eq((await getOccurrence(k)).postpone, { date: "2026-09-24", time: "12:01" });
});
await t("لا ماضي", "T3", "Quick بهدف غير صالح زمنيًا (مقدار هائل يتجاوز حدود التاريخ) ⇒ رفض organizer_postpone_invalid_target دون تغيير", async () => {
  const k = await makeStandalone();
  const before = clone(await getOccurrence(k));
  await rejects(() => quickPostpone(k, { amount: 1e15, unit: "minutes" }, NOW), "organizer_postpone_invalid_target");
  await rejects(() => quickPostpone(k, { amount: 1e12, unit: "hours" }, NOW), "organizer_postpone_invalid_target");
  await rejects(() => quickPostpone(k, { amount: 1e9, unit: "days" }, NOW), "organizer_postpone_invalid_target");
  await rejects(() => quickPostpone(k, { amount: 3000000, unit: "days" }, NOW), "organizer_postpone_invalid_target");
  eq(await getOccurrence(k), before);
});
await t("لا ماضي", "T4", "Quick دائمًا بعد لحظة التنفيذ: حدّ الدقيقة (10:00:59.999 + دقيقة ⇒ 10:01) وحدّ منتصف الليل", async () => {
  const k = await makeStandalone();
  const r = await quickPostpone(k, { amount: 1, unit: "minutes" }, new Date(2026, 9, 5, 10, 0, 59, 999));
  eq(r.effective, { date: "2026-10-05", time: "10:01" });
  const k2 = await makeStandalone();
  const r2 = await quickPostpone(k2, { amount: 1, unit: "days" }, new Date(2026, 9, 5, 23, 59, 59, 999));
  eq(r2.effective, { date: "2026-10-06", time: "09:00" });
});
await t("لا ماضي", "T5", "بلا now (الوقت الحالي داخل الطبقة): 2099 مقبول، 2000 مرفوض دون تغيير؛ now غير صالح مرفوض", async () => {
  const k = await makeStandalone();
  const before = clone(await getOccurrence(k));
  await rejects(() => postponeRaw(k, { date: "2000-01-01", time: "08:00" }), "organizer_postpone_not_in_future");
  await rejects(() => postponeRaw(k, { date: "2099-01-01", time: "08:00" }, new Date("x")), "organizer_postpone_invalid_now");
  await rejects(() => postponeRaw(k, { date: "2099-01-01", time: "08:00" }, "2026-01-01"), "organizer_postpone_invalid_now");
  eq(await getOccurrence(k), before);
  await postponeRaw(k, { date: "2099-01-01", time: "08:00" });
  eq((await getOccurrence(k)).postpone, { date: "2099-01-01", time: "08:00" });
});
await t("لا ماضي", "T6", "الرفض (ماضٍ/مساوٍ/غير صالح) لا يغيّر root_id ولا أي سجل في السلسلة", async () => {
  const id = nid("T6");
  await makeSeries(id, 4);
  const before = await list(id);
  const k = keyFor(id, "2026-10-03");
  await rejects(() => postponeRaw(k, { date: "2026-09-01", time: "08:00" }, NOW), "organizer_postpone_not_in_future");
  await rejects(() => postponeRaw(k, { date: "2026-09-24", time: "12:00" }, NOW), "organizer_postpone_not_in_future");
  await rejects(() => quickPostpone(k, { amount: 1e15, unit: "minutes" }, NOW), "organizer_postpone_invalid_target");
  eq(await list(id), before);
});

// ================== عزل ==================
const dbs = (indexedDB.databases ? await indexedDB.databases() : []).map((d) => d.name).sort();
window.__ISOLATION = {
  sessionStorageLength: sessionStorage.length,
  localStorageLength: localStorage.length,
  indexedDBNames: dbs,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};
window.__RESULTS = RESULTS;
window.__DONE = true;
