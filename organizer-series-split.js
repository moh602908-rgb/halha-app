/* ============================================================
   organizer-series-split.js — Organizer Core: Series Split
   ("Every time" من تاريخ D فقط)
   ============================================================
   طبقة مستقلة فوق الملفات الأربعة المعتمدة دون أي تعديل عليها:
   organizer-db.js / organizer-crud.js / organizer-recurrence.js /
   organizer-editing.js.

   الاستيراد:
   - openOrganizerDB من organizer-db.js (لتنفيذ الانقسام داخل
     Transaction واحدة ذرّية، فإمّا أن تنجح كل خطواته أو لا يتغيّر شيء).
   - computeNextDate من organizer-recurrence.js (دالة نقية، تُستخدَم
     فقط للتحقق من صلاحية تعريف التكرار الجديد قبل أي كتابة).
   لا شبكة، لا fetch، لا AI، لا sessionStorage/localStorage، لا مكتبات.

   القرار المعتمد المُنفَّذ حرفيًا (بحسب البنية الفعلية الحالية):
   1. الجزء القديم يحتفظ بـ root_id القديم (R1) — لا يُلمَس.
   2. series_end للجزء القديم = D - 1، ويقع داخل recurrence الخاص
      بسجل الجذر (occ_key === root_id) — لا حقل جديد ولا schema جديدة.
   3. الجزء الجديد يبدأ من D، بسجل جذر جديد (occ_key === root_id === R2)
      يحمل تعريف التكرار الجديد وحده.
   4. لا نقل ولا إعادة إنشاء لأي حدوث تاريخه قبل D.
   5. لا يوجد تعريفا recurrence مختلفان تحت root_id واحد: الجذر وحده
      هو الحامل لـ recurrence في كل سلسلة.

   قرار تنفيذي جديد يحتاج اعتماد المالك (D1):
   الحدوثات المولَّدة مسبقًا تحت R1 وتاريخها >= D:
   - حدوث upcoming بلا أي override (Placeholder ولّده التكرار القديم):
     يُستثنى ناعمًا (override.excluded = true) — لا حذف فعلي — حتى لا
     يظهر مكرّرًا مع حدوث الجذر الجديد R2 عند D.
   - أي حدوث آخر (حالة نهائية completed/not_completed، أو له override
     فيه أي محتوى، أي اختيار/تعديل صريح من المستخدم): يبقى كما هو دون
     أي تغيير ويُعاد ذكره في retained_occ_keys.
   ============================================================ */

import { openOrganizerDB } from "./organizer-db.js";
import { computeNextDate } from "./organizer-recurrence.js";

const OCCURRENCES_STORE = "occurrences";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function isValidISODate(str) {
  if (typeof str !== "string" || !ISO_DATE_RE.test(str)) return false;
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function dayBefore(str) {
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function generateRootId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return `root_${globalThis.crypto.randomUUID()}`;
  }
  throw new Error("organizer_split_no_id_generator: مرّر new_root_id صراحة");
}

// تحويل طلب IndexedDB إلى Promise — يُستخدَم داخل Transaction واحدة فقط.
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
 * ينفّذ Series Split لسلسلة متكررة عند التاريخ D (= split_date).
 *
 * @param {object} params
 * @param {string} params.root_id          معرّف الجزء القديم R1 (يبقى كما هو)
 * @param {string} params.split_date       D بصيغة YYYY-MM-DD (بداية الجزء الجديد)
 * @param {string} [params.new_root_id]    R2 — يُولَّد تلقائيًا إن لم يُمرَّر
 * @param {object} [params.new_recurrence] تعريف التكرار الجديد بنفس البنية
 *        المعتمدة؛ إن غاب يُنسخ تعريف R1 كما هو. إن لم يحتوِ على series_end
 *        يرث الجزء الجديد series_end الأصلي لـ R1 (إن وُجد)، وإن احتوى عليه
 *        بقيمة null يصبح بلا نهاية.
 * @param {string} [params.title]          عنوان الجزء الجديد (يرث من جذر R1 إن غاب)
 * @param {string} [params.itemType]       نوع العنصر (يرث إن غاب)
 * @param {string|null} [params.time]      الوقت (يرث إن غاب)
 * @returns {Promise<object>} {old_root_id, new_root_id, split_date,
 *          old_series_end, new_root, excluded_occ_keys, retained_occ_keys}
 */
export async function splitSeriesFromDate(params = {}) {
  const { root_id, split_date, new_recurrence } = params;

  if (!root_id || typeof root_id !== "string") {
    throw new Error("organizer_split_missing_root_id: root_id مطلوب");
  }
  if (!isValidISODate(split_date)) {
    throw new Error(`organizer_split_invalid_date: "${split_date}" — الصيغة المطلوبة YYYY-MM-DD لتاريخ حقيقي`);
  }
  const new_root_id = params.new_root_id !== undefined ? params.new_root_id : generateRootId();
  if (!new_root_id || typeof new_root_id !== "string") {
    throw new Error("organizer_split_invalid_new_root_id: new_root_id يجب أن يكون نصًا غير فارغ");
  }
  if (new_root_id === root_id) {
    throw new Error("organizer_split_same_root_id: root_id الجديد يجب أن يختلف عن القديم");
  }
  if (new_recurrence !== undefined && (new_recurrence === null || typeof new_recurrence !== "object")) {
    throw new Error("organizer_split_invalid_recurrence: new_recurrence يجب أن يكون كائنًا");
  }

  const db = await openOrganizerDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(OCCURRENCES_STORE, "readwrite");
    const store = tx.objectStore(OCCURRENCES_STORE);
    let result;
    let failure = null;

    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = () => { db.close(); reject(failure || tx.error || new Error("organizer_split_aborted")); };
    const fail = (err) => {
      if (!failure) failure = err;
      try { tx.abort(); } catch (_) { /* Transaction انتهت/أُلغيت مسبقًا */ }
    };

    (async () => {
      // ---------- قراءة والتحقق (لا كتابة قبل اكتمال كل الفحوص) ----------
      const root = await reqP(store.get(root_id));
      if (!root) {
        throw new Error(`organizer_series_not_found: لا سلسلة بالمعرّف ${root_id}`);
      }
      if (root.root_id !== root_id) {
        throw new Error(`organizer_split_not_a_root: ${root_id} ليس سجل جذر لسلسلة`);
      }
      if (!root.recurrence || typeof root.recurrence !== "object") {
        throw new Error(`organizer_invalid_recurrence_type: السلسلة ${root_id} بلا قاعدة تكرار صالحة`);
      }
      if (!(split_date > root.date)) {
        throw new Error(
          `organizer_split_not_after_series_start: D (${split_date}) يجب أن يكون بعد تاريخ بداية السلسلة (${root.date})`
        );
      }
      const oldEnd = root.recurrence.series_end;
      if (oldEnd && split_date > oldEnd) {
        throw new Error(
          `organizer_split_after_series_end: D (${split_date}) بعد series_end الحالي (${oldEnd})`
        );
      }

      // تعريف التكرار الجديد
      const newRec = new_recurrence !== undefined ? { ...new_recurrence } : { ...root.recurrence };
      const explicitEnd = new_recurrence !== undefined && hasOwn(new_recurrence, "series_end");
      if (!explicitEnd) {
        if (oldEnd) newRec.series_end = oldEnd; else delete newRec.series_end;
      } else if (newRec.series_end == null) {
        delete newRec.series_end;
      }
      computeNextDate(split_date, newRec); // يرمي خطأ إن كان التعريف غير صالح (النوع/weekdays/anchor_day)
      if (newRec.series_end !== undefined &&
          (!isValidISODate(newRec.series_end) || newRec.series_end < split_date)) {
        throw new Error(
          `organizer_split_invalid_series_end: series_end الجديد (${newRec.series_end}) يجب أن يكون تاريخًا صالحًا لا يسبق D`
        );
      }

      const newTitle = hasOwn(params, "title") ? params.title : root.title;
      if (!newTitle || typeof newTitle !== "string" || !newTitle.trim()) {
        throw new Error("organizer_missing_title: title حقل إلزامي للجزء الجديد");
      }
      const newItemType = hasOwn(params, "itemType") ? params.itemType : root.itemType;
      const newTime = hasOwn(params, "time") ? (params.time || null) : (root.time || null);

      // R2 يجب ألا يكون موجودًا، ولا يوجد أي سجل يحمل root_id هذا (لا اختلاط)
      if ((await reqP(store.get(new_root_id))) !== undefined) {
        throw new Error(`organizer_split_new_root_id_exists: occ_key ${new_root_id} موجود مسبقًا`);
      }
      if ((await reqP(store.index("root_id_idx").count(new_root_id))) > 0) {
        throw new Error(`organizer_split_new_root_id_exists: root_id ${new_root_id} مستخدم مسبقًا`);
      }

      // ---------- تصنيف الحدوثات المولَّدة مسبقًا التي تاريخها >= D ----------
      const series = await reqP(store.index("root_id_idx").getAll(root_id));
      const toExclude = [];
      const retained = [];
      for (const occ of series) {
        if (occ.occ_key === root.occ_key) continue;                       // الجذر نفسه
        if (typeof occ.date !== "string" || occ.date < split_date) continue; // قبل D: لا يُلمَس إطلاقًا
        if (occ.override && occ.override.excluded === true) continue;     // مستثنى سابقًا: يبقى كما هو
        const isPlaceholder =
          occ.status === "upcoming" && (!occ.override || Object.keys(occ.override).length === 0);
        if (isPlaceholder) toExclude.push(occ); else retained.push(occ.occ_key);
      }

      // ---------- الكتابة (كلها داخل نفس Transaction) ----------
      const oldSeriesEnd = dayBefore(split_date);
      await reqP(store.put({ ...root, recurrence: { ...root.recurrence, series_end: oldSeriesEnd } }));

      const newRoot = {
        occ_key: new_root_id,
        root_id: new_root_id,
        title: newTitle,
        itemType: newItemType,
        time: newTime,
        date: split_date,
        status: "upcoming",
        recurrence: newRec,
      };
      await reqP(store.add(newRoot));

      for (const occ of toExclude) {
        await reqP(store.put({ ...occ, override: { ...(occ.override || {}), excluded: true } }));
      }

      result = {
        old_root_id: root_id,
        new_root_id,
        split_date,
        old_series_end: oldSeriesEnd,
        new_root: newRoot,
        excluded_occ_keys: toExclude.map((o) => o.occ_key),
        retained_occ_keys: retained,
      };
    })().catch(fail);
  });
}
