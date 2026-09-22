/* ============================================================
   organizer-db.js — Organizer Core: طبقة تهيئة IndexedDB فقط
   ============================================================
   نطاق هذا الملف: فتح/تهيئة قاعدة بيانات المنظّم المحلية وإنشاء
   Object Store الأساسي، دون أي منطق تكرار أو حالة أو واجهة.

   عزل عن مسار AI (Technical Decision — Organizer/AI Isolation):
   - وحدة مستقلة تمامًا، لا تستورد ولا تُستورَد من app.js أو أي كود
     خاص بـ AI_ENDPOINT/askAI/sessionStorage الحالي.
   - لا شبكة، لا fetch، لا اتصال خارجي من أي نوع.
   - غير مربوطة بأي واجهة أو زر حاليًا (تُدمَج لاحقًا في خطوة منفصلة).

   الحقول المخزَّنة أدناه مقتصرة على ما ورد اسمه صراحة في القرارات
   المعتمدة (root_id، occ_key، title، status بقيمه الثلاث المخزَّنة،
   itemType عبر آلية reminder⟷appointment، series_end، override).
   حقلا recurrence وoverride يُحفَظان ككائنين مرنين (بنية داخلية غير
   مُلزَمة بعد) لأن الشكل التفصيلي الدقيق لمحتوياتهما لم يُحسَم بعد
   كمخطط بيانات حرفي في أي قرار سابق — هذا مُعلَّم صراحة في التقرير
   المرفق، وليس اختراعًا صامتًا لسلوك جديد.
   ============================================================ */

const ORGANIZER_DB_NAME = "dallini-organizer";
const ORGANIZER_DB_VERSION = 1;
const OCCURRENCES_STORE = "occurrences";

/**
 * يفتح (وعند الحاجة يُهيّئ لأول مرة) قاعدة بيانات المنظّم المحلية.
 * لا يقرأ ولا يكتب أي سجل — تهيئة البنية فقط.
 * @returns {Promise<IDBDatabase>}
 */
export function openOrganizerDB() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) {
      reject(new Error("organizer_db_unsupported: indexedDB غير متاح في هذه البيئة"));
      return;
    }

    const request = indexedDB.open(ORGANIZER_DB_NAME, ORGANIZER_DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(OCCURRENCES_STORE)) {
        // occ_key هو المفتاح الأساسي — فريد لكل حدوث فردي (Phase 1/2).
        const store = db.createObjectStore(OCCURRENCES_STORE, { keyPath: "occ_key" });

        // فهرس root_id: ضروري لإيجاد كل حدوثات نفس السلسلة (لعمليات
        // مثل Series Split وseries_end)، دون علاقة بمنطق تنفيذها هنا.
        store.createIndex("root_id_idx", "root_id", { unique: false });

        // فهرس status: ضروري لاحقًا لاستعلام Today (Missed/Upcoming/
        // Completed) دون تحميل كل السجلات — لا منطق ترتيب هنا، فقط
        // البنية التي تُمكّن الاستعلام لاحقًا.
        store.createIndex("status_idx", "status", { unique: false });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * شكل السجل المتوقَّع داخل occurrences (توثيقي فقط، لا يُطبَّق أو
 * يُتحقَّق منه هنا — لا إنشاء ولا قراءة لأي سجل في هذا الملف):
 *
 * {
 *   occ_key:   string,   // المفتاح الأساسي — فريد لكل حدوث
 *   root_id:   string,   // ثابت عبر السلسلة (Series Split لا يغيّره)
 *   title:     string,   // الحقل الوحيد الإلزامي للمهام (UX Core)
 *   itemType:  "task" | "reminder" | "appointment",
 *   date:      string | null,
 *   time:      string | null,   // فارغ للمهام بلا وقت
 *   status:    "upcoming" | "completed" | "not_completed", // المخزَّنة فقط؛ missed/postponed مشتقتان أو انتقال، لا تُخزَّنان كحالة
 *   series_end: string | null,  // إغلاق ناعم للسلسلة (Technical Decision — Delete/Edit)
 *   recurrence: object | null,  // بنية داخلية غير محسومة بعد — placeholder فقط
 *   override:   object | null   // بنية داخلية غير محسومة بعد — placeholder فقط
 * }
 */
export const OCCURRENCE_RECORD_SHAPE_NOTE =
  "راجع التعليق أعلاه — recurrence وoverride بنيتهما الداخلية غير محسومة بعد.";
