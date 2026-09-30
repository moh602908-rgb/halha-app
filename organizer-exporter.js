/* ============================================================
   organizer-exporter.js — Event Exporter: مصدر موحّد للأحداث القادمة
   ============================================================
   دالة قراءة نقية على مستوى العقد الخارجي: لا تخزين إضافي، لا شبكة.
   هذا هو العقد الذي سيستهلكه Android لاحقًا دون تعديل:
   {
     event_id, entity_id, entity_kind, fire_at (ISO), title,
     recurrence_rule, source_occ_key, domain, voice_eligible, dedup_key
   }
   لا تُخزَّن الأحداث نفسها: تُشتق من time_entities (organizer-time.js) و
   occurrences (organizer-schedule.js/organizer-crud.js) في كل نداء، فتبقى
   IndexedDB (القاعدتان) مصدر الحقيقة الوحيد. منع التكرار مضمون بالتصميم:
   event_id حتمي من (المعرّف + اللحظة الفعلية)، فإعادة الحساب تعطي نفس
   المعرّفات دائمًا؛ طبقة التنفيذ (SW/الصفحة/Android لاحقًا) هي من تتذكر
   محليًا آخر event_id نُفِّذ.
   ============================================================ */

import { listEntities, nextAlarmFireAt, getEntity } from "./organizer-time.js";
import { getSettings } from "./organizer-settings.js";
import { getOccurrence } from "./organizer-crud.js";
import { getEffectiveSchedule } from "./organizer-postpone.js";
import { buildVoiceText } from "./organizer-voice.js";

function toIso(d) { return new Date(d).toISOString(); }

function alarmEvent(a, fromDate, toDate) {
  const fire = nextAlarmFireAt(a, fromDate);
  if (!fire || fire > toDate) return null;
  return {
    event_id: `${a.id}::${fire.toISOString()}`,
    entity_id: a.id, entity_kind: "alarm", fire_at: fire.toISOString(), title: a.title,
    recurrence_rule: a.days && a.days.length ? { days: a.days } : null,
    source_occ_key: null, domain: null,
  };
}

function durationEvent(rec, fromMs, toMs) {
  if (rec.status !== "running" || rec.target_at == null) return null;
  if (rec.target_at < fromMs || rec.target_at > toMs) return null;
  return {
    event_id: `${rec.id}::${rec.target_at}`,
    entity_id: rec.id, entity_kind: rec.kind, fire_at: toIso(rec.target_at), title: rec.title,
    recurrence_rule: null, source_occ_key: null, domain: null,
  };
}

async function reminderEvent(rec, fromMs, toMs) {
  const occ = await getOccurrence(rec.occ_key);
  if (!occ) return null; // الموعد حُذف؛ لا حدث بلا مصدر
  const eff = getEffectiveSchedule(occ);
  if (!eff || !eff.date || !eff.time) return null; // بلا وقت محدد، لا يمكن جدولة تذكير
  if (occ.override && occ.override.excluded) return null;
  if (occ.status === "completed") return null;
  const [y, mo, d] = eff.date.split("-").map(Number);
  const [h, mi] = eff.time.split(":").map(Number);
  const occMs = new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  const fireMs = occMs - rec.fire_offset_min * 60 * 1000;
  if (fireMs < fromMs || fireMs > toMs) return null;
  return {
    event_id: `${rec.id}::${rec.occ_key}::${fireMs}`,
    entity_id: rec.id, entity_kind: "reminder", fire_at: toIso(fireMs), title: rec.title,
    recurrence_rule: null, source_occ_key: rec.occ_key, domain: occ.domain || null,
    // داخلي فقط لحساب voice_eligible أدناه؛ يُحذف قبل إرجاع العقد النهائي.
    _voiceEnabled: rec.voice_enabled,
  };
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
  for (const a of alarms) { const e = alarmEvent(a, fromDate, toDate); if (e) out.push(e); }
  for (const rec of [...timers, ...countdowns]) { const e = durationEvent(rec, fromMs, toMs); if (e) out.push(e); }
  for (const rec of reminders) {
    // eslint-disable-next-line no-await-in-loop
    const e = await reminderEvent(rec, fromMs, toMs);
    if (e) out.push(e);
  }

  for (const e of out) {
    const voiceEnabled = e._voiceEnabled; delete e._voiceEnabled;
    e.voice_eligible = buildVoiceText(e, { voiceEnabled }, settings) !== null;
    e.dedup_key = e.event_id;
  }
  out.sort((a, b) => (a.fire_at < b.fire_at ? -1 : a.fire_at > b.fire_at ? 1 : 0));
  return out;
}

/**
 * النص الصوتي الفعلي لحدث معيَّن (وليس مجرد voice_eligible). تُعاد الحسابات كاملة
 * (لا تخزين للنص)، لتُستهلك من voice-tts-web.js عند لحظة النطق فقط.
 */
export async function getVoiceTextForEvent(event) {
  if (!event || event.entity_kind !== "reminder") return null;
  const [settings, entity] = await Promise.all([getSettings(), getEntity(event.entity_id)]);
  return buildVoiceText(event, { voiceEnabled: entity ? entity.voice_enabled : undefined }, settings);
}
