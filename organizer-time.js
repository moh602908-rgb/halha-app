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
     last_fired_at,               // منع التكرار
     created_at, updated_at
   }
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

async function updateEntityFields(id, patch) {
  const existing = await getEntity(id);
  if (!existing) throw new Error(`organizer_time_not_found: لا يوجد عنصر زمني بالمعرّف ${id}`);
  const merged = { ...existing, ...patch, id, updated_at: Date.now() };
  return put(merged);
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

/* ================= المنبّه ================= */

/** منبّه جديد. days=null يعني مرة واحدة (اليوم إن لم يفت وقته، وإلا غدًا — يُحسب عند القراءة لا عند الإنشاء). */
export async function createAlarm({ title, time, days = null, enabled = true }) {
  const rec = { id: genId(), kind: "alarm", title: title.trim(), time, days, enabled: !!enabled, status: "idle", created_at: Date.now(), updated_at: Date.now() };
  assertBase(rec); assertAlarm(rec);
  return put(rec);
}
export const setAlarmEnabled = (id, enabled) => updateEntityFields(id, { enabled: !!enabled });

/**
 * أقرب لحظة تشغيل مطلقة لمنبّه بعد "from" (Date). null إن كان enabled=false أو بيانات غير صالحة.
 * أيام متكررة: أقرب يوم مطابق (اليوم نفسه إن لم يفت وقته). مرة واحدة (days=null): اليوم إن لم يفت، وإلا غدًا.
 */
export function nextAlarmFireAt(alarm, from = new Date()) {
  if (!alarm || alarm.kind !== "alarm" || !alarm.enabled || !TIME_RE.test(alarm.time || "")) return null;
  const [h, m] = alarm.time.split(":").map(Number);
  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate(), h, m, 0, 0);
  if (!alarm.days || alarm.days.length === 0) {
    return base > from ? base : new Date(base.getTime() + 24 * 60 * 60 * 1000);
  }
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(base.getTime() + i * 24 * 60 * 60 * 1000);
    if (alarm.days.includes(DAYS[candidate.getDay()]) && candidate > from) return candidate;
  }
  return null; // لا يقع نظريًا (days غير فارغة تضمن تطابقًا خلال 7 أيام)
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
  const rec = await getEntity(id);
  if (!rec) throw new Error("organizer_time_not_found");
  if (rec.status === "fired") return rec;
  return updateEntityFields(id, { status: "fired", last_fired_at: Date.now() });
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
