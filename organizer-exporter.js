/* ============================================================
   organizer-exporter.js — Event Exporter: مصدر موحّد للأحداث القادمة
   ============================================================
   دالة قراءة نقية على مستوى العقد الخارجي: لا تخزين إضافي، لا شبكة.
   هذا هو العقد الذي سيستهلكه Android لاحقًا دون تعديل:
   {
     event_id, entity_id, entity_kind, target_at (ISO: الموعد الأصلي)، fire_at (ISO: لحظة الإطلاق)،
     title, recurrence_rule, source_occ_key, domain, voice_eligible, dedup_key
   }
   Snooze طبقة فوق العقد: حدث إضافي بنفس الحقول + snooze:true، event_id مميَّز (`<id>::snooze::<ms>`)،
   fire_at = snoozed_until، وtarget_at = الموعد الأصلي؛ لا يستبدل حدث الجدولة الأصلية.
   لا تُخزَّن الأحداث نفسها: تُشتق من time_entities (organizer-time.js) و
   occurrences (organizer-schedule.js/organizer-crud.js) في كل نداء، فتبقى
   IndexedDB (القاعدتان) مصدر الحقيقة الوحيد. منع التكرار مضمون بالتصميم:
   event_id حتمي من (المعرّف + اللحظة الفعلية)، فإعادة الحساب تعطي نفس
   المعرّفات دائمًا؛ طبقة التنفيذ (SW/الصفحة/Android لاحقًا) هي من تتذكر
   محليًا آخر event_id نُفِّذ.
   ============================================================ */

import {
  listEntities, nextAlarmFireAt, getEntity,
  alarmDueState, snoozeStatus, startOfNextLocalDayMs,
} from "./organizer-time.js";
import { getSettings } from "./organizer-settings.js";
import { getOccurrence } from "./organizer-crud.js";
import { getEffectiveSchedule } from "./organizer-postpone.js";
import { buildVoiceText } from "./organizer-voice.js";

function toIso(d) { return new Date(d).toISOString(); }

function alarmEventAt(a, fireMs) {
  const iso = new Date(fireMs).toISOString();
  return {
    event_id: `${a.id}::${iso}`,
    entity_id: a.id, entity_kind: "alarm", target_at: iso, fire_at: iso, title: a.title,
    recurrence_rule: a.days && a.days.length ? { days: a.days } : null,
    source_occ_key: null, domain: null,
  };
}

function alarmEvent(a, fromDate, toDate) {
  const fire = nextAlarmFireAt(a, fromDate);
  if (!fire || fire > toDate) return null;
  return alarmEventAt(a, fire.getTime());
}

/** حدث Snooze: نفس حقول العقد، event_id مميَّز، fire_at = snoozed_until، target_at = الموعد الأصلي. */
function snoozeEventOf(rec, snoozedUntilMs, targetMs, base) {
  const eventId = `${rec.id}::snooze::${snoozedUntilMs}`;
  return { ...base, event_id: eventId, target_at: toIso(targetMs), fire_at: toIso(snoozedUntilMs), snooze: true };
}

function durationEventAt(rec) {
  return {
    event_id: `${rec.id}::${rec.target_at}`,
    entity_id: rec.id, entity_kind: rec.kind, target_at: toIso(rec.target_at), fire_at: toIso(rec.target_at), title: rec.title,
    recurrence_rule: null, source_occ_key: null, domain: null,
  };
}

function durationEvent(rec, fromMs, toMs) {
  if (rec.status !== "running" || rec.target_at == null) return null;
  if (rec.target_at < fromMs || rec.target_at > toMs) return null;
  return durationEventAt(rec);
}

/** توقيت تذكير مشتق من موعده (بلا تخزين). null إن لم يصلح (موعد محذوف/مستثنى/منجز/بلا وقت). */
async function resolveReminderTiming(rec) {
  const occ = await getOccurrence(rec.occ_key);
  if (!occ) return null; // الموعد حُذف؛ لا حدث بلا مصدر
  const eff = getEffectiveSchedule(occ);
  if (!eff || !eff.date || !eff.time) return null; // بلا وقت محدد، لا يمكن جدولة تذكير
  if (occ.override && occ.override.excluded) return null;
  if (occ.status === "completed") return null;
  const [y, mo, d] = eff.date.split("-").map(Number);
  const [h, mi] = eff.time.split(":").map(Number);
  const occMs = new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  return { occ, occMs, fireMs: occMs - rec.fire_offset_min * 60 * 1000 };
}

function reminderEventOf(rec, timing) {
  return {
    event_id: `${rec.id}::${rec.occ_key}::${timing.fireMs}`,
    entity_id: rec.id, entity_kind: "reminder", target_at: toIso(timing.occMs), fire_at: toIso(timing.fireMs), title: rec.title,
    recurrence_rule: null, source_occ_key: rec.occ_key, domain: timing.occ.domain || null,
    // داخلي فقط لحساب voice_eligible أدناه؛ يُحذف قبل إرجاع العقد النهائي.
    _voiceEnabled: rec.voice_enabled,
  };
}

/** يضيف voice_eligible وdedup_key ويحذف الحقول الداخلية (مشترك بين القادم والمستحق). */
function finalize(out, settings) {
  for (const e of out) {
    const voiceEnabled = e._voiceEnabled; delete e._voiceEnabled;
    e.voice_eligible = buildVoiceText(e, { voiceEnabled }, settings) !== null;
    e.dedup_key = e.event_id;
  }
  out.sort((a, b) => (a.fire_at < b.fire_at ? -1 : a.fire_at > b.fire_at ? 1 : 0));
  return out;
}

/**
 * الأحداث القادمة بين from و to (كائنا Date، شاملين الحدين). القائمة مرتبة بـfire_at.
 * voice_eligible تُحسب لكل حدث اعتمادًا على الإعدادات الحالية (استدعاء settings واحد لكل نداء، لا لكل حدث).
 */
export async function listUpcomingEvents(from, to) {
  const fromDate = from instanceof Date ? from : new Date(from);
  const toDate = to instanceof Date ? to : new Date(to);
  const fromMs = fromDate.getTime(), toMs = toDate.getTime();
  if (!(fromMs <= toMs)) throw new Error("organizer_exporter_invalid_range: نطاق غير صالح");

  const [alarms, timers, countdowns, reminders, settings] = await Promise.all([
    listEntities("alarm"), listEntities("timer"), listEntities("countdown"), listEntities("reminder"), getSettings(),
  ]);

  const out = [];
  for (const a of alarms) {
    const e = alarmEvent(a, fromDate, toDate); if (e) out.push(e);
    // Snooze طبقة فوق الجدولة: حدث إضافي بلا استبدال لحدث الجدولة الأصلية.
    const sn = snoozeStatus(a, fromMs);
    if (sn && sn.pending && sn.snoozedUntil >= fromMs && sn.snoozedUntil <= toMs) {
      out.push(snoozeEventOf(a, sn.snoozedUntil, a.snooze_origin_due_at || sn.snoozedUntil, alarmEventAt(a, sn.snoozedUntil)));
    }
  }
  for (const rec of [...timers, ...countdowns]) { const e = durationEvent(rec, fromMs, toMs); if (e) out.push(e); }
  for (const rec of reminders) {
    // eslint-disable-next-line no-await-in-loop
    const timing = await resolveReminderTiming(rec);
    if (!timing) continue;
    if (timing.fireMs >= fromMs && timing.fireMs <= toMs) out.push(reminderEventOf(rec, timing));
    const sn = snoozeStatus(rec, fromMs);
    if (sn && sn.pending && sn.snoozedUntil >= fromMs && sn.snoozedUntil <= toMs) {
      out.push(snoozeEventOf(rec, sn.snoozedUntil, timing.occMs, reminderEventOf(rec, timing)));
    }
  }
  return finalize(out, settings);
}

/**
 * الأحداث المستحقة الآن (nowMs) وفق سياسة الفائت — مصدر قرار "ماذا نُطلق الآن" لطبقة التنفيذ (Web اليوم، وAndroid لاحقًا).
 * قراءة فقط (لا تكتب). غير المتكرر (تذكير/مؤقت/عدّ تنازلي/منبّه لمرة): من الاستحقاق حتى نهاية اليوم المحلي نفسه.
 * المنبّه المتكرر: من dueAt حتى بداية الدورة التالية. لا إطلاق تاريخي ولا تراكم. المُطلَق سابقًا (last_fired_event_id) مستبعَد.
 * الحجز الذرّي للإطلاق مسؤولية المستدعي عبر claimFiring/claimSnoozeFire.
 */
export async function listDueEvents(now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new Error("organizer_exporter_invalid_range: لحظة غير صالحة");
  const [alarms, timers, countdowns, reminders, settings] = await Promise.all([
    listEntities("alarm"), listEntities("timer"), listEntities("countdown"), listEntities("reminder"), getSettings(),
  ]);
  const out = [];
  for (const a of alarms) {
    const st = alarmDueState(a, nowMs);
    if (st.due) out.push(alarmEventAt(a, st.due.dueMs));
    if (st.snooze && st.snooze.due) out.push(snoozeEventOf(a, st.snooze.snoozedUntil, st.snooze.originDueMs === null ? st.snooze.snoozedUntil : st.snooze.originDueMs, alarmEventAt(a, st.snooze.snoozedUntil)));
  }
  for (const rec of [...timers, ...countdowns]) {
    if (rec.status !== "running" || typeof rec.target_at !== "number") continue;
    if (rec.target_at > nowMs || nowMs >= startOfNextLocalDayMs(rec.target_at)) continue;
    const e = durationEventAt(rec);
    if (rec.last_fired_event_id === e.event_id) continue;
    out.push(e);
  }
  for (const rec of reminders) {
    // eslint-disable-next-line no-await-in-loop
    const timing = await resolveReminderTiming(rec);
    if (!timing) continue;
    const e = reminderEventOf(rec, timing);
    if (timing.fireMs <= nowMs && nowMs < startOfNextLocalDayMs(timing.fireMs) && rec.last_fired_event_id !== e.event_id) out.push(e);
    const sn = snoozeStatus(rec, nowMs);
    if (sn && sn.due) out.push(snoozeEventOf(rec, sn.snoozedUntil, timing.occMs, reminderEventOf(rec, timing)));
  }
  return finalize(out, settings);
}

/**
 * النص الصوتي الفعلي لحدث معيَّن (وليس مجرد voice_eligible). تُعاد الحسابات كاملة
 * (لا تخزين للنص)، لتُستهلك من voice-tts-web.js عند لحظة النطق فقط.
 */
export async function getVoiceTextForEvent(event) {
  if (!event || (event.entity_kind !== "reminder" && event.entity_kind !== "alarm")) return null;
  const [settings, entity, occ] = await Promise.all([
    getSettings(), getEntity(event.entity_id), event.source_occ_key ? getOccurrence(event.source_occ_key) : null,
  ]);
  // priority يُقرأ من الموعد الأصلي (حقل Foundation موجود)؛ لا يدخل في عقد الحدث ولا يُخزَّن.
  return buildVoiceText(event, { voiceEnabled: entity ? entity.voice_enabled : undefined, priority: occ ? occ.priority : undefined }, settings);
}
