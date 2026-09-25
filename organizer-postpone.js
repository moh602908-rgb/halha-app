/* ============================================================
   organizer-postpone.js — Organizer Core: طبقة Postpone
   (Quick Postpone + Custom Postpone، لحدوث واحد فقط)
   ============================================================
   طبقة مستقلة فوق الملفات المعتمدة دون أي تعديل عليها:
   organizer-db.js / organizer-crud.js / organizer-recurrence.js /
   organizer-editing.js / organizer-series-split.js.

   الاستيراد: openOrganizerDB من organizer-db.js فقط (لتنفيذ
   القراءة والتحقق والكتابة داخل Transaction واحدة، فلا تسبق حالةٌ
   تتغير بين الفحص والكتابة). لا شبكة، لا fetch، لا AI/Gemini،
   لا sessionStorage/localStorage، لا مكتبات. IndexedDB مصدر الحقيقة.

   القرارات المعتمدة المُطبَّقة:
   - التأجيل يخص حدوثًا واحدًا فقط: لا يمس root_id ولا occ_key ولا
     recurrence ولا أي حدوث آخر في السلسلة، ولا يؤثر على توليد التالي
     (التوليد يعتمد تاريخ السجل الأصلي لا التاريخ الفعّال).
   - الحدوث المؤجَّل يبقى status = "upcoming" بالوقت الجديد
     (postponed ليست حالة مخزَّنة). missed مشتقة وغير مخزَّنة، لذلك
     الحدوث الفائت هو upcoming مخزَّنًا ويمكن تأجيله.
   - يُرفَض تأجيل completed / not_completed.
   - يُرفَض تأجيل الحدوث المستثنى (override.excluded === true).
   - التأجيل آلية مستقلة عن Override/Exception: يُخزَّن في حقل مستقل
     postpone = { date, time } داخل سجل الحدوث نفسه، ولا يُكتب داخل
     override ولا يستبدل أي محتوى فيه — فيبقى Override السابق محفوظًا.
   - الوقت الفعّال للحدوث (getEffectiveSchedule):
       postpone (إن وُجد، بالكامل)  >  override.date/time  >  الأصل.
     أي تأجيل جديد يستبدل التأجيل السابق فقط.

   افتراضات تنفيذية لم يحسمها قرار سابق (تحتاج اعتمادًا):
   A1) Quick Postpone نسبي إلى "الآن" (now قابل للحقن للاختبار):
       minutes/hours: الوقت الجديد = الآن + المقدار (الثواني تُسقَط).
       days: التاريخ الجديد = تاريخ اليوم المحلي + المقدار مع إبقاء
       الوقت الفعّال الحالي للحدوث (إن كان بلا وقت يبقى بلا وقت).
       قائمة الخيارات السريعة الجاهزة (مثل «ساعة»، «غدًا») مسؤولية
       الواجهة لاحقًا؛ هذه الطبقة تقبل مقدارًا ووحدة فقط.
   قاعدة معتمدة: الهدف النهائي (Custom وQuick) يجب أن يكون بعد لحظة
   التنفيذ (now، والافتراضي الوقت الحالي للجهاز، وقابل للحقن للاختبار).
   إن كان في الماضي أو مساويًا للحظة التنفيذ، أو غير صالح زمنيًا،
   يُرفَض التأجيل قبل أي كتابة ولا يتغيّر السجل.
   ============================================================ */

import { openOrganizerDB } from "./organizer-db.js";

const OCCURRENCES_STORE = "occurrences";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const QUICK_UNITS = new Set(["minutes", "hours", "days"]);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const p2 = (n) => String(n).padStart(2, "0");
const localDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const localTime = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

function isValidISODate(str) {
  if (typeof str !== "string" || !ISO_DATE_RE.test(str)) return false;
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
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
 * الجدولة الفعّالة لحدوث (دالة نقية، لا تقرأ ولا تكتب):
 * postpone بالكامل إن وُجد، وإلا override.date/override.time لكل حقل
 * على حدة إن وُجد، وإلا تاريخ/وقت السجل الأصلي.
 * @returns {{date: string|null, time: string|null, source: "postpone"|"override"|"original"}}
 */
export function getEffectiveSchedule(occ) {
  if (!occ || typeof occ !== "object") {
    throw new Error("organizer_postpone_invalid_occurrence: سجل الحدوث مطلوب");
  }
  if (occ.postpone && typeof occ.postpone === "object") {
    return {
      date: occ.postpone.date == null ? null : occ.postpone.date,
      time: occ.postpone.time == null ? null : occ.postpone.time,
      source: "postpone",
    };
  }
  const ov = occ.override && typeof occ.override === "object" ? occ.override : {};
  const date = hasOwn(ov, "date") ? ov.date : occ.date;
  const time = hasOwn(ov, "time") ? ov.time : occ.time;
  return {
    date: date == null ? null : date,
    time: time == null ? null : time,
    source: hasOwn(ov, "date") || hasOwn(ov, "time") ? "override" : "original",
  };
}

// يتحقق أن الهدف تاريخ/وقت صالح وأنه بعد لحظة التنفيذ (بالتوقيت المحلي للجهاز).
function assertValidFutureTarget(target, now) {
  if (!target || !isValidISODate(target.date) ||
      (target.time !== null && !(typeof target.time === "string" && TIME_RE.test(target.time)))) {
    throw new Error(
      `organizer_postpone_invalid_target: هدف التأجيل غير صالح (${target && target.date} ${target && target.time})`
    );
  }
  const [y, m, d] = target.date.split("-").map(Number);
  const [hh, mm] = target.time ? target.time.split(":").map(Number) : [0, 0];
  const targetMs = new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
  if (!(targetMs > now.getTime())) {
    throw new Error(
      `organizer_postpone_not_in_future: الهدف ${target.date} ${target.time} ليس بعد لحظة التنفيذ`
    );
  }
}

function assertValidNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("organizer_postpone_invalid_now: now يجب أن يكون Date صالحًا");
  }
}

// الجوهر المشترك: قراءة + فحوص الرفض + كتابة postpone، كلها في Transaction واحدة.
async function applyPostpone(occ_key, resolveTarget, now) {
  if (!occ_key || typeof occ_key !== "string") {
    throw new Error("organizer_missing_occ_key: occ_key مطلوب للتأجيل");
  }
  const db = await openOrganizerDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(OCCURRENCES_STORE, "readwrite");
    const store = tx.objectStore(OCCURRENCES_STORE);
    let result;
    let failure = null;

    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = () => { db.close(); reject(failure || tx.error || new Error("organizer_postpone_aborted")); };
    const fail = (err) => {
      if (!failure) failure = err;
      try { tx.abort(); } catch (_) { /* Transaction انتهت/أُلغيت مسبقًا */ }
    };

    (async () => {
      const existing = await reqP(store.get(occ_key));
      if (!existing) {
        throw new Error(`organizer_not_found: لا يوجد حدوث بالمفتاح ${occ_key}`);
      }
      if (existing.override && existing.override.excluded === true) {
        throw new Error(`organizer_postpone_excluded: الحدوث ${occ_key} مستثنى/محذوف عبر Override — لا يُؤجَّل`);
      }
      if (existing.status !== "upcoming") {
        throw new Error(
          `organizer_postpone_terminal_status: الحدوث ${occ_key} حالته "${existing.status}" — يُؤجَّل upcoming فقط`
        );
      }

      const previous = getEffectiveSchedule(existing);
      const target = resolveTarget(existing, previous); // قد يرمي خطأ تحقق
      assertValidFutureTarget(target, now);              // قبل أي كتابة
      const updated = { ...existing, postpone: { date: target.date, time: target.time } };
      await reqP(store.put(updated));

      result = {
        occ_key: updated.occ_key,
        root_id: updated.root_id,
        status: updated.status,
        postpone: updated.postpone,
        previous_effective: { date: previous.date, time: previous.time },
        effective: { date: target.date, time: target.time },
        record: updated,
      };
    })().catch(fail);
  });
}

/**
 * Custom Postpone: تاريخ ووقت يحدّدهما المستخدم (كلاهما إلزامي).
 * @param {string} occ_key
 * @param {{date: string, time: string}} target  YYYY-MM-DD و HH:MM (24 ساعة)
 * @param {Date} [now]  لحظة التنفيذ (الافتراضي الوقت الحالي؛ قابل للحقن للاختبار)
 */
export async function postponeOccurrence(occ_key, target = {}, now = new Date()) {
  const { date, time } = target || {};
  if (!isValidISODate(date)) {
    throw new Error(`organizer_postpone_invalid_date: "${date}" — الصيغة المطلوبة YYYY-MM-DD لتاريخ حقيقي`);
  }
  if (typeof time !== "string" || !TIME_RE.test(time)) {
    throw new Error(`organizer_postpone_invalid_time: "${time}" — الصيغة المطلوبة HH:MM (00:00–23:59)`);
  }
  assertValidNow(now);
  return applyPostpone(occ_key, () => ({ date, time }), now);
}

/**
 * Quick Postpone: تأجيل نسبي إلى الآن (الافتراض A1 أعلاه).
 * @param {string} occ_key
 * @param {{amount: number, unit: "minutes"|"hours"|"days"}} spec  amount عدد صحيح موجب
 * @param {Date} [now]  الوقت الحالي المحلي (قابل للحقن للاختبار)
 */
export async function quickPostpone(occ_key, spec = {}, now = new Date()) {
  const { amount, unit } = spec || {};
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`organizer_postpone_invalid_amount: "${amount}" — عدد صحيح موجب مطلوب`);
  }
  if (!QUICK_UNITS.has(unit)) {
    throw new Error(`organizer_postpone_invalid_unit: "${unit}" — المسموح minutes | hours | days`);
  }
  assertValidNow(now);

  return applyPostpone(occ_key, (_existing, previous) => {
    if (unit === "days") {
      const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + amount);
      return { date: localDate(t), time: previous.time };
    }
    const ms = amount * (unit === "hours" ? 3600000 : 60000);
    const t = new Date(now.getTime() + ms);
    return { date: localDate(t), time: localTime(t) };
  }, now);
}
