/* ============================================================
   organizer-selection.js — Organizer Core: طبقة اختيار للقراءة فقط
   ============================================================
   طبقة مستقلة جديدة، لا تعدّل أي ملف معتمد. الاستيراد: openOrganizerDB
   فقط من organizer-db.js. لا شبكة، لا AI.

   لماذا هذا الملف ضروري (وليس اختياريًا): organizer-crud.js يوفّر
   listOccurrencesByRootId (سلسلة واحدة فقط) ولا توجد أي دالة تجلب كل
   الحدوثات عبر كل السلاسل. شاشة Today تحتاج بيانات من كل السلاسل
   معًا، فهذه الفجوة حقيقية لا يمكن سدّها بدون كود جديد. تم تقييم هذا
   صراحة في تحليل Today UI (راجع التقرير المرفق) قبل إنشاء هذا الملف.

   النطاق: قراءة خام فقط — بلا أي فلترة أو تصنيف أو ترتيب (ذلك من
   اختصاص organizer-today.js وorchestration الواجهة، لا هنا).
   ============================================================ */

import { openOrganizerDB } from "./organizer-db.js";

/**
 * يُعيد كل سجلات الحدوثات في المخزن، بلا أي فلترة. دالة قراءة فقط.
 * @returns {Promise<object[]>}
 */
export async function listAllOccurrences() {
  const db = await openOrganizerDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("occurrences", "readonly");
    const req = tx.objectStore("occurrences").getAll();
    tx.oncomplete = () => db.close();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      db.close();
      reject(req.error);
    };
  });
}
