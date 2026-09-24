/* ============================================================
   organizer-editing.js — Organizer Core: طبقة Delete/Edit الفردي
   ============================================================
   نطاق هذا الملف: حذف "ناعم" (Override/Exception) وتعديل محتوى
   لحدوث واحد فقط — فوق طبقة CRUD الحالية دون أي تعديل عليها أو
   على organizer-db.js أو organizer-recurrence.js.

   الاستيراد الوحيد: updateOccurrence، getOccurrence من
   organizer-crud.js. لا وصول مباشر لـIndexedDB، لا شبكة، لا AI.

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
   ============================================================ */

import { getOccurrence, updateOccurrence } from "./organizer-crud.js";

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
  const allowed = {};
  if (Object.prototype.hasOwnProperty.call(changes, "title")) allowed.title = changes.title;
  if (Object.prototype.hasOwnProperty.call(changes, "date")) allowed.date = changes.date;
  if (Object.prototype.hasOwnProperty.call(changes, "time")) allowed.time = changes.time;

  if (Object.keys(allowed).length === 0) {
    throw new Error("organizer_no_editable_fields: مرّر title و/أو date و/أو time على الأقل");
  }

  const existing = await getOccurrence(occ_key);
  if (!existing) {
    throw new Error(`organizer_not_found: لا يوجد حدوث بالمفتاح ${occ_key}`);
  }

  // دمج مع أي override سابق (مثل excluded من عملية حذف سابقة) بدل استبداله بالكامل.
  const mergedOverride = { ...(existing.override || {}), ...allowed };
  return updateOccurrence(occ_key, { override: mergedOverride });
}
