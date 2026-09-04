/* ============================================================
   lib/monitor.js — المراقبة الأساسية للمالك (الإصدار الثاني —
   Owner Dashboard الخطوة 2)
   ============================================================
   الهدف: "عين بسيطة" على حالة النظام — عدّادات مجمّعة فقط، بدون أي
   محتوى أو معلومة يمكن ربطها بمستخدم معيّن.

   قيود التصميم (صارمة ومقصودة، لم تتغيّر عن الإصدار الأول):
   1) recordEvent() تقبل معاملًا واحدًا فقط من قائمة مغلقة (Enum) —
      لا يوجد أي حقل حرّ (req, details, metadata...) يمكن أن يحمل
      بيانات شخصية عبره، حتى بالخطأ من تعديل مستقبلي.
   2) Fail-silent كامل: أي خطأ داخلي يُلتقط ولا يُعاد رميه أبدًا،
      فلا يمكن لهذا الملف أن يُسقط أو يُبطئ طلب المستخدم الأصلي.
   3) بدون await وبدون أي I/O: عمليات في الذاكرة فقط، تنفيذ متزامن.
   4) نفس نمط التخزين المعتمد أصلًا في lib/ratelimit.js
      (globalThis)، غير موزّع وغير دائم — مقبول هنا لأن الهدف مؤشر
      تقريبي وليس سجلًا دائمًا.

   إضافات هذا الإصدار (Owner Dashboard):
   - 6 أنواع أحداث جديدة (سدّ فجوة تسجيل + حدثا اللوحة/الإغراق).
     العدّاد اليومي لكل الأحداث (القديمة والجديدة) يعمل دائمًا بلا أي
     استثناء أو تعليق — سلوك العدّاد اليومي الحالي لم يتغيّر إطلاقًا.
   - نافذة زمنية دوّارة منفصلة (10 دقائق / 5 حاويات × دقيقتان،
     القيم من CONFIG) تُستخدم حصريًا لكشف إغراق الأحداث المرفوضة —
     لا علاقة لها بالعدّاد اليومي أعلاه ولا تُبدّله.
   - عند تجاوز REJECT_FLOOD_THRESHOLD ضمن النافذة: تتوقف زيادة
     الحاوية التفصيلية لبقية نوبة الإغراق، ويُسجَّل
     reject_flood_detected في العدّاد اليومي مرة واحدة فقط عند لحظة
     تجاوز العتبة (لا يتكرر طوال استمرار النوبة).
   - لا يزال هذا الملف لا يستورد req أو أي بيانات من العميل — فقط
     CONFIG (أرقام إعداد بحتة، لا صلة لها بأي مستخدم فردي).

   لا توجد نقطة عرض (API) لهذه البيانات بعد — تُضاف في خطوة منفصلة
   لاحقة (Owner Dashboard endpoint)، هذا الملف معزول تمامًا عنها.
   ============================================================ */

import { CONFIG } from "./config.js";

// قائمة الأحداث المسموحة حصرًا — أي قيمة خارج هذه القائمة تُتجاهل بصمت.
const ALLOWED_EVENTS = Object.freeze([
  "too_fast",
  "quota_limit",
  "origin_block",
  "provider_error",
  "validation_error",
  "intent_injection_block",
  "method_not_allowed",
  "unsupported_content_type",
  "bad_request",
  "empty_question",
  "reject_flood_detected",
  "owner_auth_failed"
]);

// الأحداث التي تُحسب ضمن نافذة كشف الإغراق — رفض مباشر لطلب مستخدم
// فقط. تُستبعد عمدًا: provider_error (فشل مزوّد، ليس رفضًا)،
// owner_auth_failed (مسار منفصل خاص باللوحة)، وreject_flood_detected
// نفسها (تجنّب حلقة ذاتية).
const REJECTION_EVENTS_FOR_FLOOD = Object.freeze([
  "too_fast",
  "quota_limit",
  "origin_block",
  "validation_error",
  "intent_injection_block",
  "method_not_allowed",
  "unsupported_content_type",
  "bad_request",
  "empty_question"
]);

const WINDOW_BUCKET_COUNT = 5; // 5 حاويات × دقيقتان = نافذة 10 دقائق (من CONFIG)

function todayKeyUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function emptyCounts() {
  const counts = {};
  for (const name of ALLOWED_EVENTS) counts[name] = 0;
  return counts;
}

function getMonitorState() {
  if (!globalThis.__dallini_monitor) {
    globalThis.__dallini_monitor = { date: todayKeyUTC(), counts: emptyCounts() };
  }
  const state = globalThis.__dallini_monitor;
  const today = todayKeyUTC();
  if (state.date !== today) {
    state.date = today;
    state.counts = emptyCounts();
  }
  return state;
}

function getWindowBucketMs() {
  const minutes = Number.isFinite(CONFIG.MONITOR_WINDOW_MINUTES) && CONFIG.MONITOR_WINDOW_MINUTES > 0
    ? CONFIG.MONITOR_WINDOW_MINUTES
    : 10;
  return (minutes * 60 * 1000) / WINDOW_BUCKET_COUNT;
}

function getWindowState() {
  if (!globalThis.__dallini_monitor_window) {
    globalThis.__dallini_monitor_window = {
      // كل حاوية: {slot, count}. slot = رقم دوري مطلق لفترة الحاوية
      // (غير مرتبط بتاريخ اليوم) — يُستخدم لتمييز الحاويات المنتهية
      // الصلاحية عند إعادة استخدام نفس الفهرس الدوّار.
      buckets: Array.from({ length: WINDOW_BUCKET_COUNT }, () => ({ slot: -1, count: 0 })),
      floodActive: false
    };
  }
  return globalThis.__dallini_monitor_window;
}

// مجموع الحاويات الصالحة فعليًا ضمن النافذة الحالية (تستبعد أي حاوية
// تخصّ فترة أقدم من عمق النافذة، حتى لو لم تُعاد تهيئتها بعد فعليًا).
function sumValidBuckets(win, currentSlot) {
  let total = 0;
  for (const bucket of win.buckets) {
    if (bucket.slot >= 0 && currentSlot - bucket.slot >= 0 && currentSlot - bucket.slot < WINDOW_BUCKET_COUNT) {
      total += bucket.count;
    }
  }
  return total;
}

function recordWindowedRejection() {
  const bucketMs = getWindowBucketMs();
  const now = Date.now();
  const slot = Math.floor(now / bucketMs);
  const idx = slot % WINDOW_BUCKET_COUNT;

  const win = getWindowState();
  const bucket = win.buckets[idx];
  if (bucket.slot !== slot) {
    // حاوية قديمة (أو غير مهيَّأة بعد) — إعادة تدويرها لتمثّل الفترة الحالية.
    bucket.slot = slot;
    bucket.count = 0;
  }

  const totalBeforeThis = sumValidBuckets(win, slot);
  const threshold = Number.isFinite(CONFIG.REJECT_FLOOD_THRESHOLD) && CONFIG.REJECT_FLOOD_THRESHOLD > 0
    ? CONFIG.REJECT_FLOOD_THRESHOLD
    : 300;

  if (totalBeforeThis >= threshold) {
    if (!win.floodActive) {
      win.floodActive = true;
      // نسجّل الحدث المجمّع مرة واحدة فقط، عند لحظة تجاوز العتبة تحديدًا.
      const state = getMonitorState();
      state.counts.reject_flood_detected += 1;
    }
    // لا نزيد عدّاد الحاوية التفصيلي طوال استمرار نوبة الإغراق — هذا
    // بالضبط ما يمنع تضخّم الأرقام التفصيلية بلا حد أعلى.
    return;
  }

  win.floodActive = false; // إعادة تسليح الكشف لنوبة إغراق مستقبلية محتملة
  bucket.count += 1;
}

/**
 * تسجيل وقوع حدث تقني — لا يقبل ولا يُخزّن أي شيء غير نوع الحدث نفسه.
 * لا ترمي أي استثناء أبدًا؛ فشلها الداخلي لا يؤثر على الطلب الأصلي.
 *
 * العدّاد اليومي يعمل دائمًا لكل الأحداث بلا استثناء (سلوك غير متغيّر).
 * الأحداث الواردة في REJECTION_EVENTS_FOR_FLOOD تُغذّي أيضًا النافذة
 * الدوّارة لغرض كشف الإغراق فقط — طبقة منفصلة تمامًا عن العدّاد اليومي.
 */
export function recordEvent(eventType) {
  try {
    if (!ALLOWED_EVENTS.includes(eventType)) return; // تجاهل صامت لأي قيمة غير معروفة

    const state = getMonitorState();
    state.counts[eventType] += 1;

    if (REJECTION_EVENTS_FOR_FLOOD.includes(eventType)) {
      recordWindowedRejection();
    }
  } catch {
    /* لا نكسر الطلب أبدًا بسبب فشل في المراقبة */
  }
}

/**
 * قراءة لقطة من الحالة الحالية (العدّاد اليومي + ملخّص النافذة
 * الدوّارة) — للاستخدام الداخلي المستقبلي فقط (نقطة Owner Dashboard).
 * غير مُستدعاة من أي نقطة API في هذا الإصدار.
 */
export function getSnapshot() {
  try {
    const state = getMonitorState();
    const win = getWindowState();
    const bucketMs = getWindowBucketMs();
    const currentSlot = Math.floor(Date.now() / bucketMs);
    return {
      date: state.date,
      counts: { ...state.counts },
      window: {
        minutes: CONFIG.MONITOR_WINDOW_MINUTES,
        rejectedInWindow: sumValidBuckets(win, currentSlot),
        floodActive: win.floodActive === true
      }
    };
  } catch {
    return null;
  }
}
