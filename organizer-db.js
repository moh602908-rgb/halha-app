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
const ORGANIZER_DB_VERSION = 2;
const BLOCKED_UPGRADE_TIMEOUT_MS = 8000;
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

    let blockedTimer = null;

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const tx = event.target.transaction;

      // v0 -> v1: إنشاء المخزن والفهرسين الأصليين (بلا أي تغيير في المعنى).
      const store = db.objectStoreNames.contains(OCCURRENCES_STORE)
        ? tx.objectStore(OCCURRENCES_STORE)
        : db.createObjectStore(OCCURRENCES_STORE, { keyPath: "occ_key" });
      const ensure = (name, keyPath) => {
        if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
      };
      // occ_key هو المفتاح الأساسي؛ root_id: كل حدوثات السلسلة؛ status: تجميع Today.
      ensure("root_id_idx", "root_id");
      ensure("status_idx", "status");

      // v1 -> v2 (Foundation): فهارس فقط، بلا إعادة كتابة أي سجل موجود.
      // السجلات القديمة تبقى كما هي؛ غياب الحقول الجديدة (domain/priority/note/space_id/endTime) = "غير محدد".
      // الفهارس تُبنى تلقائيًا من السجلات الموجودة؛ السجلات التي لا تحوي المسار لا تُفهرس.
      ensure("date_idx", "date");
      ensure("postpone_date_idx", "postpone.date"); // التاريخ الفعلي بعد التأجيل
      ensure("override_date_idx", "override.date"); // التاريخ الفعلي بعد تحرير التاريخ
      ensure("domain_idx", "domain");
      ensure("space_idx", "space_id");
    };

    // ترقية محجوبة: تبويب قديم ما زال يحمل اتصال v1. لا نتعلق للأبد.
    request.onblocked = () => {
      blockedTimer = setTimeout(
        () => reject(new Error("organizer_db_blocked: ترقية القاعدة محجوبة؛ أغلق نوافذ التطبيق الأخرى ثم أعد المحاولة")),
        BLOCKED_UPGRADE_TIMEOUT_MS
      );
    };

    request.onsuccess = (event) => {
      if (blockedTimer) clearTimeout(blockedTimer);
      const db = event.target.result;
      // لا نحجب ترقية مستقبلية من تبويب آخر: نغلق الاتصال عند طلب تغيير الإصدار.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = (event) => {
      if (blockedTimer) clearTimeout(blockedTimer);
      reject(event.target.error);
    };
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
 *   // v2 (اختيارية؛ غيابها = غير محدد — انظر organizer-model.js):
 *   endTime: "HH:MM", domain: string(slug), priority: "low"|"normal"|"high", note: string, space_id: string
 * }
 */
export const OCCURRENCE_RECORD_SHAPE_NOTE =
  "راجع التعليق أعلاه — recurrence وoverride بنيتهما الداخلية غير محسومة بعد.";
