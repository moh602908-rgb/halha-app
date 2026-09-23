/* ============================================================
   organizer-crud.js — Organizer Core: طبقة CRUD محلية فقط
   ============================================================
   نطاق هذا الملف: Create / Read / Update / Delete على مستوى
   السجل الفردي (occurrence) داخل IndexedDB، دون أي منطق تكرار،
   حالة، تأجيل، أو واجهة. مبني فوق organizer-db.js فقط.

   العزل (Technical Decision — Organizer/AI Isolation):
   - الاستيراد الوحيد هو openOrganizerDB من organizer-db.js.
   - لا fetch، لا XMLHttpRequest، لا أي اتصال شبكي.
   - لا علاقة بـ app.js أو AI_ENDPOINT أو sessionStorage.

   مصدر الحقيقة: IndexedDB وحده (Technical Decision — Full Offline).

   قيود مُطبَّقة صراحة هنا للحفاظ على قرارات Phase 1/Delete-Edit:
   - status: يقبل فقط القيم المخزَّنة المعتمدة
     upcoming | completed | not_completed
     (missed وpostponed لا تُقبَلان كقيمة تُخزَّن مباشرة — هما
     مشتقة/انتقالية بحسب القرار المعتمد، لا تُطبَّقان هنا لأن هذا
     الملف لا ينفّذ أي منطق تكرار أو تأجيل بعد).
   - occ_key: هو المفتاح الأساسي — لا يمكن تغييره عبر update()،
     أي محاولة لتمريره ضمن التعديلات تُرفَض صراحة.
   - root_id: يُحمى من التغيير الصامت عبر update() (قرار الاستقرار
     "stable root_id")، إلا إذا مُرِّر خيار صريح allowRootIdChange.
   - delete(): يحذف السجل المطلوب فقط عبر مفتاحه occ_key، ولا يمس
     أي سجل آخر يحمل نفس root_id — بحكم أن الحذف يتم بمفتاح فريد
     لا بفهرس جماعي.

   ملاحظة نطاق مهمة (غير مُطبَّقة هنا عمدًا): آلية Override/Exception
   لاستثناء حدوث واحد ضمن سلسلة متكررة نشطة (بدل حذفه فعليًا) هي
   جزء من منطق محرك التكرار، ولم يُبنَ بعد. delete() هنا حذف فعلي
   للسجل من المخزن، لا استثناء ناعم — هذا يتوافق مع كون لا توليد
   occurrences تلقائي قائمًا بعد في هذه المرحلة.
   ============================================================ */

import { openOrganizerDB } from "./organizer-db.js";

const OCCURRENCES_STORE = "occurrences";
const STORED_STATUSES = new Set(["upcoming", "completed", "not_completed"]);

function assertValidStatus(status) {
  if (status !== undefined && !STORED_STATUSES.has(status)) {
    throw new Error(
      `organizer_invalid_status: "${status}" — القيم المسموح تخزينها فقط: ${[...STORED_STATUSES].join(" | ")}`
    );
  }
}

function assertRequiredFieldsForCreate(record) {
  if (!record || typeof record !== "object") {
    throw new Error("organizer_invalid_record: السجل يجب أن يكون كائنًا");
  }
  if (!record.occ_key || typeof record.occ_key !== "string") {
    throw new Error("organizer_missing_occ_key: occ_key حقل إلزامي (مفتاح أساسي)");
  }
  if (!record.title || typeof record.title !== "string" || !record.title.trim()) {
    throw new Error("organizer_missing_title: title حقل إلزامي (الحد الأدنى لأي عنصر)");
  }
  assertValidStatus(record.status);
}

/** إنشاء حدوث جديد. يفشل صراحة إذا كان occ_key موجودًا مسبقًا. */
export async function createOccurrence(record) {
  assertRequiredFieldsForCreate(record);
  const toStore = { status: "upcoming", ...record }; // upcoming افتراضي فقط إن لم يُحدَّد
  assertValidStatus(toStore.status);

  const db = await openOrganizerDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OCCURRENCES_STORE, "readwrite");
    const store = tx.objectStore(OCCURRENCES_STORE);
    const req = store.add(toStore); // add() يفشل تلقائيًا عند تكرار المفتاح
    req.onsuccess = () => resolve(toStore);
    req.onerror = () => reject(req.error);
  });
}

/** قراءة حدوث واحد عبر occ_key. يعيد undefined إن لم يوجد. */
export async function getOccurrence(occ_key) {
  const db = await openOrganizerDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OCCURRENCES_STORE, "readonly");
    const req = tx.objectStore(OCCURRENCES_STORE).get(occ_key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** قراءة كل حدوثات نفس السلسلة (لا تُغيّر شيئًا — للتحقق والقراءة فقط). */
export async function listOccurrencesByRootId(root_id) {
  const db = await openOrganizerDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OCCURRENCES_STORE, "readonly");
    const index = tx.objectStore(OCCURRENCES_STORE).index("root_id_idx");
    const req = index.getAll(root_id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * تعديل حقول حدوث موجود. لا يسمح بتغيير occ_key إطلاقًا.
 * لا يسمح بتغيير root_id إلا إذا مُرِّر allowRootIdChange:true صراحة.
 */
export async function updateOccurrence(occ_key, changes, { allowRootIdChange = false } = {}) {
  if (!occ_key) throw new Error("organizer_missing_occ_key: occ_key مطلوب للتعديل");
  if (changes && Object.prototype.hasOwnProperty.call(changes, "occ_key")) {
    throw new Error("organizer_occ_key_immutable: لا يمكن تغيير occ_key عبر update()");
  }
  if (changes && Object.prototype.hasOwnProperty.call(changes, "root_id") && !allowRootIdChange) {
    throw new Error("organizer_root_id_protected: تغيير root_id عبر update() يتطلب allowRootIdChange صراحة");
  }
  assertValidStatus(changes && changes.status);

  const db = await openOrganizerDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OCCURRENCES_STORE, "readwrite");
    const store = tx.objectStore(OCCURRENCES_STORE);
    const getReq = store.get(occ_key);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) {
        reject(new Error(`organizer_not_found: لا يوجد حدوث بالمفتاح ${occ_key}`));
        return;
      }
      const merged = { ...existing, ...changes, occ_key: existing.occ_key };
      const putReq = store.put(merged);
      putReq.onsuccess = () => resolve(merged);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/** حذف حدوث واحد فقط عبر مفتاحه — لا يمس أي حدوث آخر بنفس root_id. */
export async function deleteOccurrence(occ_key) {
  if (!occ_key) throw new Error("organizer_missing_occ_key: occ_key مطلوب للحذف");
  const db = await openOrganizerDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OCCURRENCES_STORE, "readwrite");
    const req = tx.objectStore(OCCURRENCES_STORE).delete(occ_key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
