/* ============================================================
   organizer-editing.js — Organizer Core: طبقة Delete/Edit الفردي
   ============================================================
   نطاق هذا الملف: حذف "ناعم" (Override/Exception) وتعديل محتوى
   لحدوث واحد فقط — فوق طبقة CRUD الحالية دون أي تعديل عليها أو
   على organizer-db.js أو organizer-recurrence.js.

   الاستيراد: updateOccurrence، getOccurrence من organizer-crud.js،
   وopenOrganizerDB من organizer-db.js (لمسار واحد فقط: تعديل date/time
   لحدوث مؤجَّل، حيث يجب حذف حقل postpone فعليًا في Transaction واحدة).
   لا شبكة، لا AI.

   القرارات المطبَّقة هنا حرفيًا:
   - حذف حدوث واحد = دمج override.excluded = true مع أي override
     سابق (لا استبدال) — لا حذف فعلي للسجل، لا حالة سادسة، status
     لا يتغيّر بسبب الحذف.
   - تعديل المحتوى (title/date/time) يُخزَّن داخل override المرتبط
     بنفس occ_key (دمجًا مع أي override سابق)، دون لمس الحقول
     الأصلية للسجل مباشرة — التعديل الجزئي يمر عبر آلية
     Override/Exception حرفيًا، لا كتابة مباشرة فوق تعريف السجل.
   - كلا الإجراءين يدمجان مع override الموجود بدل استبداله، حتى لا
     يفقد Edit سابق بياناته عند Delete لاحق، أو العكس.
   - كلا الإجراءين يعملان بعد completed/not_completed دون أي قيد،
     لأن organizer-crud.js لا يفرض أي قيد على status أصلًا.
   - Series Split غير مُنفَّذ هنا عمدًا (قرار منفصل لاحق).
   - بعد Postpone: تعديل date و/أو time عبر editOccurrenceContent()
     يحذف حقل postpone (فيصبح override.date/time هو الوقت الفعّال)،
     أمّا تعديل title فقط فلا يمس postpone. لا timestamps ولا أولوية جديدة.
   ============================================================ */

import { getOccurrence, updateOccurrence } from "./organizer-crud.js";
import { openOrganizerDB } from "./organizer-db.js";
import { getEffectiveSchedule } from "./organizer-postpone.js";
import { assertValidField, assertEndAfterStart } from "./organizer-model.js";

/**
 * حذف ناعم لحدوث واحد: يدمج override.excluded = true مع أي override
 * سابق (مثل تعديل محتوى سبق تطبيقه) بدل استبداله بالكامل.
 * لا يحذف السجل، لا يمس occ_key أو root_id، لا يمس أي حدوث آخر.
 */
export async function deleteOccurrence(occ_key) {
  const existing = await getOccurrence(occ_key);
  if (!existing) {
    throw new Error(`organizer_not_found: لا يوجد حدوث بالمفتاح ${occ_key}`);
  }
  const mergedOverride = { ...(existing.override || {}), excluded: true };
  return updateOccurrence(occ_key, { override: mergedOverride });
}

/**
 * تعديل محتوى حدوث واحد ("this time only"): title و/أو date و/أو
 * time فقط — يُخزَّن داخل override المرتبط بـocc_key نفسه، دون لمس
 * الحقول الأصلية للسجل مباشرة (تصحيح معتمد: التعديل الجزئي يجب أن
 * يمر عبر آلية Override/Exception، لا كتابة مباشرة فوق تعريف السجل).
 * أي حقل آخر غير title/date/time يُتجاهَل عمدًا لحماية
 * occ_key/root_id/status من هذه الواجهة تحديدًا.
 */
export async function editOccurrenceContent(occ_key, changes = {}) {
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const allowed = {};
  if (has(changes, "title")) allowed.title = changes.title;
  if (has(changes, "date")) allowed.date = changes.date;
  if (has(changes, "time")) allowed.time = changes.time;
  // Foundation v2: endTime قابل للتحرير "لهذه المرة فقط" (null = مسح النهاية).
  const editsEnd = has(changes, "endTime");
  if (editsEnd) {
    assertValidField("endTime", changes.endTime);
    allowed.endTime = changes.endTime === undefined ? null : changes.endTime;
  }

  if (Object.keys(allowed).length === 0) {
    throw new Error("organizer_no_editable_fields: لا توجد حقول قابلة للتحرير (title / date / time / endTime)");
  }

  const existing = await getOccurrence(occ_key);
  if (!existing) {
    throw new Error(`organizer_not_found: لا يوجد حدوث بالمفتاح ${occ_key}`);
  }

  // تحرير التاريخ/الوقت على موعد مؤجَّل: يسقط postpone ويصبح override هو الجدولة الفعلية.
  const touchesSchedule = has(allowed, "date") || has(allowed, "time");
  const postponed = has(existing, "postpone");

  // تحرير endTime على موعد مؤجَّل: النهاية الصريحة مطلقة بالنسبة للبداية المؤجَّلة الحالية، لذلك تُثبَّت البداية
  // الفعلية في override ويُسقَط postpone (نفس الجدولة الفعلية، ونفس مبدأ editDroppingPostpone).
  if (editsEnd && postponed && !touchesSchedule) {
    const eff = getEffectiveSchedule(existing);
    allowed.date = eff.date;
    allowed.time = eff.time;
  }

  // التحقق قبل الكتابة: النهاية الصريحة يجب أن تكون بعد البداية الفعلية الناتجة (ولا نهاية بلا بداية).
  const prospective = { ...existing, override: { ...(existing.override || {}), ...allowed } };
  if (has(allowed, "date") || has(allowed, "time")) delete prospective.postpone;
  const ov = prospective.override;
  if (has(ov, "endTime") && ov.endTime != null) {
    assertEndAfterStart(getEffectiveSchedule(prospective).time, ov.endTime);
  }

  if (postponed && (has(allowed, "date") || has(allowed, "time"))) {
    return editDroppingPostpone(occ_key, allowed);
  }

  // تحرير عادي: دمج في override (مع الحفاظ على excluded وغيره) بلا مساس بالبقية.
  const mergedOverride = { ...(existing.override || {}), ...allowed };
  return updateOccurrence(occ_key, { override: mergedOverride });
}

// كتابة واحدة ذرّية: دمج التعديل في override (دون فقدان أي override سابق)
// وحذف حقل postpone فعليًا من السجل. لا يمس occ_key/root_id/status/recurrence.
function editDroppingPostpone(occ_key, allowed) {
  return openOrganizerDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("occurrences", "readwrite");
    const store = tx.objectStore("occurrences");
    let result;
    let failure = null;
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = () => { db.close(); reject(failure || tx.error || new Error("organizer_edit_aborted")); };
    const getReq = store.get(occ_key);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) {
        failure = new Error(`organizer_not_found: لا يوجد حدوث بالمفتاح ${occ_key}`);
        tx.abort();
        return;
      }
      const { postpone: _dropped, ...rest } = rec;
      const merged = { ...rest, override: { ...(rec.override || {}), ...allowed } };
      const putReq = store.put(merged);
      putReq.onsuccess = () => { result = merged; };
    };
  }));
}
