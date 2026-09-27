/* ============================================================
   organizer-series-stop.js — Organizer Core: إيقاف سلسلة متكررة
   ============================================================
   طبقة مستقلة جديدة، بلا تعديل على أي ملف معتمد. الاستيراد:
   openOrganizerDB فقط من organizer-db.js. لا شبكة، لا AI.

   لماذا هذا الملف ضروري: Functional Specification البند 7-ب يضع
   "حذف نسخة/إيقاف السلسلة" ضمن التعديلات التي تُشغِّل سؤال "هذه
   المرة فقط/كل مرة". اختيار "هذه المرة فقط" مغطّى بالكامل فعليًا عبر
   deleteOccurrence في organizer-editing.js (بلا أي تعديل عليه).
   اختيار "كل مرة" يعني إيقاف السلسلة كاملة — البند 6: "يوقف كل
   التكرارات المستقبلية فورًا دون التأثير على النُّسخ الماضية" — لا
   دالة موجودة تنفّذ هذا تحديدًا؛ هذا الملف يسدّ تلك الفجوة فقط.

   الفرق عن organizer-series-split.js: لا يُنشئ جزءًا جديدًا ولا
   root_id جديدًا؛ فقط يضبط series_end على نفس الجذر القائم، ويستثني
   ناعمًا أي حدوثات مولَّدة مسبقًا (Placeholder بلا override/postpone)
   بتاريخ لاحق — بنفس منطق الاستثناء المعتمد فعليًا في
   organizer-series-split.js، مكرَّر هنا عمدًا (لا استيراد بينهما)
   لتفادي أي تعديل على ذلك الملف المعتمد.

   قرار تنفيذي (راجع التقرير): "فورًا" = تاريخ اليوم الحالي
   (device-local) وقت تنفيذ الإجراء، بصرف النظر عن تاريخ النسخة
   المحدَّدة التي ضغط المستخدم "حذف" عليها فعليًا — يطابق حرفيًا
   الصياغة العامة للبند 7-ب ("بأثر فوري على النسخ المستقبلية").
   ============================================================ */

import { openOrganizerDB } from "./organizer-db.js";

const OCCURRENCES_STORE = "occurrences";
const p2 = (n) => String(n).padStart(2, "0");
const localDateStr = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

function dayBefore(str) {
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return localDateStr(dt);
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      reject(req.error);
    };
  });
}

/**
 * يوقف سلسلة متكررة بأثر فوري (البند 7-ب: خيار "كل مرة" لإجراء
 * حذف/إيقاف). لا ينشئ root_id جديدًا. لا يمس أي حدوث تاريخه اليوم
 * أو قبله.
 * @param {string} root_id
 * @param {Date} [now]
 * @returns {Promise<{root_id, series_end, excluded_occ_keys}>}
 */
export async function stopSeries(root_id, now = new Date()) {
  if (!root_id || typeof root_id !== "string") {
    throw new Error("organizer_stop_missing_root_id: root_id مطلوب");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("organizer_stop_invalid_now: now يجب أن يكون Date صالحًا");
  }
  const todayStr = localDateStr(now);
  const db = await openOrganizerDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(OCCURRENCES_STORE, "readwrite");
    const store = tx.objectStore(OCCURRENCES_STORE);
    let result;
    let failure = null;
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = () => { db.close(); reject(failure || tx.error || new Error("organizer_stop_aborted")); };
    const fail = (err) => { if (!failure) failure = err; try { tx.abort(); } catch (_) { /* انتهت مسبقًا */ } };

    (async () => {
      const root = await reqP(store.get(root_id));
      if (!root) throw new Error(`organizer_series_not_found: لا سلسلة بالمعرّف ${root_id}`);
      if (root.root_id !== root_id) throw new Error(`organizer_stop_not_a_root: ${root_id} ليس سجل جذر لسلسلة`);
      if (!root.recurrence || typeof root.recurrence !== "object") {
        throw new Error(`organizer_invalid_recurrence_type: السلسلة ${root_id} بلا قاعدة تكرار صالحة`);
      }

      const cutoff = dayBefore(todayStr); // series_end الجديد — لا يمس اليوم الحالي ولا قبله
      // إن كانت موقوفة أصلًا بتاريخ أبكر (مثلًا من عملية إيقاف سابقة)، لا نؤخّرها.
      const newSeriesEnd =
        root.recurrence.series_end && root.recurrence.series_end < cutoff
          ? root.recurrence.series_end
          : cutoff;
      await reqP(store.put({ ...root, recurrence: { ...root.recurrence, series_end: newSeriesEnd } }));

      const series = await reqP(store.index("root_id_idx").getAll(root_id));
      const excluded = [];
      for (const occ of series) {
        if (occ.occ_key === root.occ_key) continue; // الجذر نفسه لا يُستثنى، فقط series_end يُحدِّد توليده لاحقًا
        if (typeof occ.date !== "string" || occ.date <= todayStr) continue; // اليوم وما قبله لا يُمسّان إطلاقًا (وليس فقط ما قبل cutoff)
        if (occ.override && occ.override.excluded === true) continue; // مستثنى سابقًا: يبقى كما هو
        const isPlaceholder =
          occ.status === "upcoming" && !occ.postpone &&
          (!occ.override || Object.keys(occ.override).length === 0);
        if (isPlaceholder) {
          await reqP(store.put({ ...occ, override: { ...(occ.override || {}), excluded: true } }));
          excluded.push(occ.occ_key);
        }
        // غير Placeholder (له postpone/override صريح): يبقى كما هو، بلا أي تغيير — اختيار صريح سابق من المستخدم.
      }

      result = { root_id, series_end: newSeriesEnd, excluded_occ_keys: excluded };
    })().catch(fail);
  });
}
