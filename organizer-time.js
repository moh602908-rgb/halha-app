/* ============================================================
   organizer-time.js — Time Core: منبّه/مؤقت/عدّ تنازلي/تذكير
   ============================================================
   مبدأ أساسي: لا setInterval كمصدر حقيقة. كل شيء يُشتق من طوابع زمنية
   مطلقة (target_at / fire_at) وDate.now() عند الحاجة، فإغلاق الصفحة
   وإعادة فتحها لا يفقد أي دقة (نفس مبدأ getEffectiveEnd في Foundation).

   time_entities:
   {
     id, kind: "alarm"|"timer"|"countdown"|"reminder", title, status,
     enabled,                    // alarm فقط: تشغيل/إيقاف بلا حذف
     time, days,                 // alarm: "HH:MM"، days: ["SU".."SA"] أو null (لمرة واحدة اليوم/غدًا)
     duration_ms,                 // timer/countdown: المدة الأصلية
     target_at,                  // timer/countdown: لحظة الانتهاء المطلقة (تُعاد حسابها عند pause/resume)
     remaining_ms_at_pause,       // timer/countdown: الباقي وقت الإيقاف المؤقت
     occ_key, fire_offset_min, voice_enabled, // reminder فقط
     last_fired_at,               // وقت آخر إطلاق فعلي (معلومة، لا يحسم التكرار)
     last_fired_event_id,         // منع التكرار: نفس event_id لا يُطلق مرتين (حاسم، ذرّي عبر claimFiring)
     armed_at,                    // alarm: لحظة التسليح (إنشاء/إعادة تفعيل)؛ لا يُطلق ما قبلها
     due_at,                      // alarm لمرة واحدة فقط: لحظة الاستحقاق المطلقة (تُشتق من created_at للسجلات القديمة)
     snoozed_until, snooze_origin_due_at, // alarm/reminder: طبقة Snooze مؤقتة فوق الجدولة الأصلية (لا تغيّرها)
     created_at, updated_at
   }

   سياسة الفائت (قرار المالك النهائي):
   - غير متكرر (منبّه لمرة واحدة، تذكير، مؤقت، عدّ تنازلي): صالح من لحظة الاستحقاق حتى نهاية اليوم المحلي نفسه، وبعده فائت نهائيًا.
   - منبّه متكرر: صالح من dueAt حتى بداية الدورة التالية (الموعد المجدول التالي لنفس المنبّه)، وبعدها فائت نهائيًا.
   - لا إطلاق بأثر رجعي ولا تراكم: يُنظر دائمًا إلى آخر موعد مجدول فقط.
   - last_fired_event_id يمنع التكرار ولا يحوّل المنبّه المتكرر إلى حالة منتهية (status لا يتغير للمتكرر).
   - Snooze: طبقة مؤقتة؛ تُلغى تلقائيًا إذا بدأت الدورة التالية، وتُمسح بعد إطلاقها.
   ============================================================ */

import { openTimeDB, _STORES } from "./organizer-timedb.js";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS = Object.freeze(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
const KINDS = Object.freeze(["alarm", "timer", "countdown", "reminder"]);
const STATUSES = Object.freeze(["idle", "running", "paused", "fired", "cancelled"]);

const genId = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `te_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

function assertBase(rec) {
  if (!KINDS.includes(rec.kind)) throw new Error("organizer_time_invalid_field:kind");
  if (typeof rec.title !== "string" || rec.title.trim() === "") throw new Error("organizer_time_invalid_field:title");
  if (rec.status !== undefined && !STATUSES.includes(rec.status)) throw new Error("organizer_time_invalid_field:status");
}
function assertAlarm(rec) {
  if (!TIME_RE.test(rec.time || "")) throw new Error("organizer_time_invalid_field:time");
  if (rec.days !== undefined && rec.days !== null) {
    if (!Array.isArray(rec.days) || rec.days.some((d) => !DAYS.includes(d))) throw new Error("organizer_time_invalid_field:days");
  }
}
function assertDurationMs(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error("organizer_time_invalid_field:duration_ms");
}

async function put(rec) {
  const db = await openTimeDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_STORES.ENTITIES_STORE, "readwrite");
    tx.objectStore(_STORES.ENTITIES_STORE).put(rec);
    tx.oncomplete = () => resolve(rec);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getEntity(id) {
  const db = await openTimeDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(_STORES.ENTITIES_STORE, "readonly").objectStore(_STORES.ENTITIES_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** كل السجلات، أو المصفاة بنوع واحد عبر الفهرس (لا مسح كامل غير ضروري لكل الأنواع مجتمعة). */
export async function listEntities(kind) {
  const db = await openTimeDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction(_STORES.ENTITIES_STORE, "readonly").objectStore(_STORES.ENTITIES_STORE);
    const req = kind ? store.index("kind_idx").getAll(kind) : store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * قراءة ثم كتابة داخل معاملة IndexedDB واحدة (readwrite) — ذرّية: لا تضيع كتابة متزامنة (تبويبان/Tick متداخل).
 * fn(rec|undefined) → { write: سجل جديد أو null/undefined، result: قيمة الإرجاع }. رمي استثناء داخل fn يُلغي المعاملة.
 */
async function mutateEntity(id, fn) {
  const db = await openTimeDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_STORES.ENTITIES_STORE, "readwrite");
    const store = tx.objectStore(_STORES.ENTITIES_STORE);
    let result;
    const req = store.get(id);
    req.onsuccess = () => {
      try {
        const out = fn(req.result) || {};
        if (out.write) store.put(out.write);
        result = out.result;
      } catch (e) { reject(e); try { tx.abort(); } catch { /* تجاهل */ } }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("organizer_time_tx_aborted"));
  });
}

const notFound = (id) => new Error(`organizer_time_not_found: لا يوجد عنصر زمني بالمعرّف ${id}`);

async function updateEntityFields(id, patch) {
  return mutateEntity(id, (existing) => {
    if (!existing) throw notFound(id);
    const merged = { ...existing, ...patch, id, updated_at: Date.now() };
    return { write: merged, result: merged };
  });
}
export const updateEntity = updateEntityFields;

export async function deleteEntity(id) {
  const db = await openTimeDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_STORES.ENTITIES_STORE, "readwrite");
    tx.objectStore(_STORES.ENTITIES_STORE).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/* ================= أدوات الوقت المحلي (مطلقة ← محلية) ================= */

const MINUTE_MS = 60 * 1000;
/** سقف Snooze (دقائق): يمنع قيمًا سخيفة؛ والدورة التالية تلغيه تلقائيًا للمنبّه المتكرر على أي حال. */
export const MAX_SNOOZE_MINUTES = 12 * 60;

const hm = (t) => t.split(":").map(Number);
/** لحظة محلية مطلقة (ms) = يوم الأساس + dayOffset بتاريخ تقويمي، عند h:m (بلا جمع 24 ساعة، فلا يتأثر بتغيّر التوقيت الصيفي). */
function localAt(baseMs, dayOffset, h, m) {
  const d = new Date(baseMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, h, m, 0, 0).getTime();
}
/** بداية اليوم المحلي التالي للحظة ms (حد حصري لنافذة "حتى نهاية اليوم نفسه"). */
export function startOfNextLocalDayMs(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}
/** أول لحظة محلية بساعة time بعد afterMs (اليوم إن لم تفت، وإلا غدًا). */
function firstLocalOccurrenceAfter(time, afterMs) {
  const [h, m] = hm(time);
  for (let i = 0; i <= 2; i++) { const t = localAt(afterMs, i, h, m); if (t > afterMs) return t; }
  return localAt(afterMs, 3, h, m);
}
const isRecurringAlarm = (a) => Array.isArray(a.days) && a.days.length > 0;

/** لمنبّه متكرر: آخر موعد مجدول ≤ nowMs (prev) وأول موعد مجدول > nowMs (next). */
function recurringNeighbors(alarm, nowMs) {
  const [h, m] = hm(alarm.time);
  let prev = null, next = null;
  for (let i = -8; i <= 8; i++) {
    const t = localAt(nowMs, i, h, m);
    if (!alarm.days.includes(DAYS[new Date(t).getDay()])) continue;
    if (t <= nowMs) prev = t;
    else if (next === null) next = t;
  }
  return { prev, next };
}

/* ================= المنبّه ================= */

/** منبّه جديد. days=null يعني مرة واحدة: due_at يُثبَّت عند الإنشاء (اليوم إن لم يفت وقته، وإلا غدًا). */
export async function createAlarm({ title, time, days = null, enabled = true }) {
  const now = Date.now();
  const rec = { id: genId(), kind: "alarm", title: title.trim(), time, days, enabled: !!enabled, status: "idle", armed_at: now, created_at: now, updated_at: now };
  assertBase(rec); assertAlarm(rec);
  if (!isRecurringAlarm(rec)) rec.due_at = firstLocalOccurrenceAfter(time, now);
  return put(rec);
}

/** تشغيل/إيقاف بلا حذف. التشغيل يعيد التسليح (لا إطلاق لما قبله)؛ الإيقاف يمسح أي Snooze. */
export async function setAlarmEnabled(id, enabled) {
  const on = !!enabled;
  return mutateEntity(id, (rec) => {
    if (!rec) throw notFound(id);
    if (on === !!rec.enabled) return { result: rec };
    const now = Date.now();
    let patch;
    if (on) {
      patch = { enabled: true, armed_at: now };
      if (!isRecurringAlarm(rec)) Object.assign(patch, { due_at: firstLocalOccurrenceAfter(rec.time, now), status: "idle", last_fired_event_id: null });
    } else {
      patch = { enabled: false, snoozed_until: null, snooze_origin_due_at: null };
    }
    const merged = { ...rec, ...patch, id, updated_at: now };
    return { write: merged, result: merged };
  });
}

/** لحظة استحقاق المنبّه غير المتكرر (ms) أو null. */
export function oneShotDueAt(alarm) {
  if (!alarm || isRecurringAlarm(alarm)) return null;
  if (typeof alarm.due_at === "number") return alarm.due_at;
  if (typeof alarm.created_at === "number" && TIME_RE.test(alarm.time || "")) return firstLocalOccurrenceAfter(alarm.time, alarm.created_at);
  return null;
}

/**
 * أقرب لحظة تشغيل مجدولة مطلقة بعد "from" (Date). null إن كان enabled=false أو بيانات غير صالحة.
 * متكرر: أقرب موعد مجدول لاحق. لمرة واحدة: due_at إن لم يحن بعد ولم يُطلق (وإلا null — لا "غدًا" تلقائي).
 */
export function nextAlarmFireAt(alarm, from = new Date()) {
  if (!alarm || alarm.kind !== "alarm" || !alarm.enabled || !TIME_RE.test(alarm.time || "")) return null;
  const fromMs = from.getTime();
  if (isRecurringAlarm(alarm)) {
    const { next } = recurringNeighbors(alarm, fromMs);
    return next === null ? null : new Date(next);
  }
  if (alarm.status === "fired") return null;
  const due = oneShotDueAt(alarm);
  return due !== null && due > fromMs ? new Date(due) : null;
}

/**
 * حالة Snooze لسجل (منبّه/تذكير) عند nowMs — دالة نقية:
 *  null = لا Snooze؛ {cancel:true} = أُلغي (بدأت الدورة التالية/انتهت نافذته)؛ {pending:true,...} = لم يحن؛
 *  {due:true, snoozedUntil, originDueMs} = حان ويجب إطلاقه (مرة واحدة).
 * منبّه متكرر: نافذته تنتهي ببداية الدورة التالية بعد origin. غيره: حتى نهاية يوم snoozed_until المحلي.
 */
export function snoozeStatus(rec, nowMs) {
  if (!rec || typeof rec.snoozed_until !== "number") return null;
  const su = rec.snoozed_until;
  const origin = typeof rec.snooze_origin_due_at === "number" ? rec.snooze_origin_due_at : null;
  let cycleEnd;
  if (rec.kind === "alarm" && isRecurringAlarm(rec) && TIME_RE.test(rec.time || "")) {
    cycleEnd = recurringNeighbors(rec, origin === null ? su : origin).next;
  } else {
    cycleEnd = startOfNextLocalDayMs(su);
  }
  if (rec.kind === "alarm" && !rec.enabled) return { cancel: true };
  if (cycleEnd === null || nowMs >= cycleEnd) return { cancel: true };
  if (su > nowMs) return { pending: true, snoozedUntil: su };
  return { due: true, snoozedUntil: su, originDueMs: origin };
}

/**
 * ما الذي يستحق الإطلاق الآن لمنبّه؟ → { due: {dueMs, eventId}|null, snooze: snoozeStatus|null }. نقية.
 * due يتحقق فقط إذا: مُسلَّح قبله، حان (≤ now)، ما زال داخل نافذته (قبل نهاية اليوم/بداية الدورة التالية)، ولم يُطلق نفس event_id.
 */
export function alarmDueState(alarm, nowMs) {
  const none = { due: null, snooze: null };
  if (!alarm || alarm.kind !== "alarm" || !alarm.enabled || !TIME_RE.test(alarm.time || "")) return none;
  const armed = typeof alarm.armed_at === "number" ? alarm.armed_at : (alarm.created_at || 0);
  let dueMs = null, windowEnd = null;
  if (isRecurringAlarm(alarm)) {
    const n = recurringNeighbors(alarm, nowMs);
    dueMs = n.prev; windowEnd = n.next;
  } else if (alarm.status !== "fired") {
    dueMs = oneShotDueAt(alarm);
    windowEnd = dueMs === null ? null : startOfNextLocalDayMs(dueMs);
  }
  let due = null;
  if (dueMs !== null && windowEnd !== null && dueMs > armed && dueMs <= nowMs && nowMs < windowEnd) {
    const eventId = `${alarm.id}::${new Date(dueMs).toISOString()}`;
    if (alarm.last_fired_event_id !== eventId) due = { dueMs, eventId };
  }
  return { due, snooze: snoozeStatus(alarm, nowMs) };
}

/* ================= Snooze (منبّه + تذكير فقط) ================= */

/**
 * يؤجّل التنبيه minutes دقيقة كطبقة مؤقتة (snoozed_until) فوق الجدولة الأصلية التي لا تتغير.
 * منبّه متكرر: إن وصل الموعد الجديد إلى بداية الدورة التالية أو تجاوزها لا يُطبَّق (يُمسح Snooze) → { applied:false, reason:"next_cycle" }.
 * opts.originDueAt: لحظة الاستحقاق الأصلية (target_at للحدث الذي يُؤجَّل)؛ افتراضيًا آخر موعد مجدول ≤ الآن.
 */
export async function snoozeEntity(id, minutes, { now = Date.now(), originDueAt } = {}) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_SNOOZE_MINUTES) {
    throw new Error("organizer_time_invalid_field:minutes");
  }
  return mutateEntity(id, (rec) => {
    if (!rec) throw notFound(id);
    if (rec.kind !== "alarm" && rec.kind !== "reminder") throw new Error("organizer_time_snooze_unsupported: Snooze للمنبّه والتذكير فقط");
    if (rec.kind === "alarm" && !rec.enabled) return { result: { applied: false, reason: "disabled", record: rec } };
    const su = now + Math.round(minutes * MINUTE_MS);
    let origin = null;
    if (rec.kind === "alarm" && isRecurringAlarm(rec)) {
      const n = recurringNeighbors(rec, now);
      origin = Number.isFinite(originDueAt) ? originDueAt : (n.prev !== null ? n.prev : now);
      const cycleEnd = recurringNeighbors(rec, origin).next;
      if (cycleEnd === null || su >= cycleEnd) {
        const cleared = { ...rec, snoozed_until: null, snooze_origin_due_at: null, updated_at: now };
        return { write: cleared, result: { applied: false, reason: "next_cycle", record: cleared } };
      }
    }
    const merged = { ...rec, snoozed_until: su, snooze_origin_due_at: origin, updated_at: now };
    return { write: merged, result: { applied: true, snoozed_until: su, record: merged } };
  });
}

/** يمسح Snooze (بلا مساس بالجدولة الأصلية). آمن إن لم يوجد Snooze. */
export async function clearSnooze(id) {
  return updateEntityFields(id, { snoozed_until: null, snooze_origin_due_at: null });
}

/* ================= الإطلاق الذرّي (منع التكرار) ================= */

/**
 * يحجز إطلاق event_id لهذا السجل ذرّيًا: true لأول من يحجز فقط (تبويبان/Tick متداخل لا يكرران).
 * opts.finish: ينهي المنبّه غير المتكرر (status="fired"). المتكرر لا يتحول لحالة منتهية أبدًا.
 */
export async function claimFiring(id, eventId, { now = Date.now(), finish = false } = {}) {
  return mutateEntity(id, (rec) => {
    if (!rec || rec.last_fired_event_id === eventId) return { result: false };
    const merged = { ...rec, last_fired_event_id: eventId, last_fired_at: now, updated_at: now, ...(finish ? { status: "fired" } : {}) };
    return { write: merged, result: true };
  });
}

/** يحجز إطلاق Snooze ويمسحه في نفس المعاملة (clearSnooze بعد الإطلاق): true لأول من يحجز فقط. */
export async function claimSnoozeFire(id, snoozedUntilMs, { now = Date.now() } = {}) {
  return mutateEntity(id, (rec) => {
    if (!rec || rec.snoozed_until !== snoozedUntilMs) return { result: false };
    const merged = { ...rec, snoozed_until: null, snooze_origin_due_at: null, last_snooze_fired_at: now, updated_at: now };
    return { write: merged, result: true };
  });
}

/**
 * تنظيف حالة منتهية (لا إطلاق): يمسح Snooze أُلغي بسياسة الدورة/اليوم، ويُنهي مؤقتًا/عدًّا فات وقته خارج نافذة اليوم
 * (status="fired" + fire_missed=true) حتى لا يبقى "قيد التشغيل" إلى الأبد ولا يُطلق بأثر رجعي.
 */
export async function sweepStaleState(nowMs = Date.now()) {
  const all = await listEntities();
  let cleared = 0, missed = 0;
  for (const rec of all) {
    if ((rec.kind === "alarm" || rec.kind === "reminder") && typeof rec.snoozed_until === "number") {
      const st = snoozeStatus(rec, nowMs);
      if (st && st.cancel) { await clearSnooze(rec.id); cleared++; }
    } else if ((rec.kind === "timer" || rec.kind === "countdown") && rec.status === "running" && typeof rec.target_at === "number"
      && rec.target_at <= nowMs && nowMs >= startOfNextLocalDayMs(rec.target_at)) {
      await updateEntityFields(rec.id, { status: "fired", fire_missed: true }); missed++;
    }
  }
  return { cleared_snoozes: cleared, missed_timers: missed };
}

/* ================= المؤقت والعدّ التنازلي ================= */

async function startDurationEntity(kind, { title, duration_ms }) {
  assertDurationMs(duration_ms);
  const now = Date.now();
  const rec = {
    id: genId(), kind, title: title.trim(), status: "running",
    duration_ms, target_at: now + duration_ms, remaining_ms_at_pause: null,
    created_at: now, updated_at: now,
  };
  assertBase(rec);
  return put(rec);
}
export const createTimer = (args) => startDurationEntity("timer", args);
export const createCountdown = (args) => startDurationEntity("countdown", args);

function assertRunnable(rec) {
  if (!rec || (rec.kind !== "timer" && rec.kind !== "countdown")) throw new Error("organizer_time_not_found: عنصر غير موجود أو ليس مؤقتًا/عدًّا تنازليًا");
}

/** الوقت المتبقي بالمللي ثانية، مشتق دائمًا من target_at/الحالة — لا setInterval هنا. أبدًا سالب. */
export function remainingMs(rec, now = Date.now()) {
  if (!rec) return 0;
  if (rec.status === "paused") return Math.max(0, rec.remaining_ms_at_pause || 0);
  if (rec.status === "running") return Math.max(0, (rec.target_at || now) - now);
  return 0; // idle/fired/cancelled
}

export async function pauseTimer(id) {
  const rec = await getEntity(id); assertRunnable(rec);
  if (rec.status !== "running") return rec;
  return updateEntityFields(id, { status: "paused", remaining_ms_at_pause: remainingMs(rec), target_at: null });
}
export async function resumeTimer(id) {
  const rec = await getEntity(id); assertRunnable(rec);
  if (rec.status !== "paused") return rec;
  const now = Date.now();
  return updateEntityFields(id, { status: "running", target_at: now + (rec.remaining_ms_at_pause || 0), remaining_ms_at_pause: null });
}
export async function cancelTimer(id) {
  const rec = await getEntity(id); assertRunnable(rec);
  return updateEntityFields(id, { status: "cancelled", target_at: null, remaining_ms_at_pause: null });
}
/** يُستدعى من طبقة العرض عند بلوغ الوقت (اشتقاق، لا مؤقت خفي). idempotent. */
export async function markFired(id) {
  return mutateEntity(id, (rec) => {
    if (!rec) throw new Error("organizer_time_not_found");
    if (rec.status === "fired") return { result: rec };
    const merged = { ...rec, status: "fired", last_fired_at: Date.now(), updated_at: Date.now() };
    return { write: merged, result: merged };
  });
}

/* ================= التذكير (مرتبط بموعد Organizer) ================= */

/** تذكير جديد مرتبط بـoccurrence. لا يخزَّن أي نص أو تاريخ هنا — يُشتق من occ_key عبر Foundation عند الاستهلاك. */
export async function createReminder({ title, occ_key, fire_offset_min = 0, voice_enabled }) {
  if (typeof occ_key !== "string" || !occ_key) throw new Error("organizer_time_invalid_field:occ_key");
  if (typeof fire_offset_min !== "number" || !Number.isFinite(fire_offset_min) || fire_offset_min < 0) {
    throw new Error("organizer_time_invalid_field:fire_offset_min");
  }
  const rec = {
    id: genId(), kind: "reminder", title: title.trim(), status: "idle",
    occ_key, fire_offset_min,
    ...(voice_enabled === undefined ? {} : { voice_enabled: !!voice_enabled }),
    created_at: Date.now(), updated_at: Date.now(),
  };
  assertBase(rec);
  return put(rec);
}
/** كل تذكيرات موعد بعينه (لحذفها/عرضها عند حذف الموعد نفسه — الحذف الفعلي من مسؤولية المستدعي). */
export async function listRemindersForOccurrence(occ_key) {
  const db = await openTimeDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(_STORES.ENTITIES_STORE, "readonly").objectStore(_STORES.ENTITIES_STORE).index("occ_key_idx").getAll(occ_key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
