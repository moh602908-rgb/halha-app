/* ============================================================
   lib/monitor.js — المراقبة الأساسية للمالك (الإصدار الثالث —
   نقل العدّاد اليومي إلى Upstash Redis)
   ============================================================
   الهدف: "عين بسيطة" على حالة النظام — عدّادات مجمّعة فقط، بدون أي
   محتوى أو معلومة يمكن ربطها بمستخدم معيّن.

   قيود التصميم (صارمة ومقصودة، لم تتغيّر عن الإصدارات السابقة):
   1) recordEvent() تقبل معاملًا واحدًا فقط من قائمة مغلقة (Enum) —
      لا يوجد أي حقل حرّ (req, details, metadata...) يمكن أن يحمل
      بيانات شخصية عبره، حتى بالخطأ من تعديل مستقبلي.
   2) Fail-silent كامل: أي خطأ داخلي يُلتقط ولا يُعاد رميه أبدًا،
      فلا يمكن لهذا الملف أن يُسقط طلب المستخدم الأصلي.
   3) العدّاد اليومي التفصيلي أصبح غير متزامن (async/await)، لأنه
      يُخزَّن الآن في Upstash Redis عبر api/_lib/redisStore.js بدل
      globalThis — هذا يُلغي القيد التوثيقي القديم الذي كان يصف
      recordEvent() كدالة متزامنة بلا I/O؛ ذلك القيد لم يعد ساريًا.
      الفشل يبقى صامتًا بالكامل بفضل سياسة Fail-open في redisStore.js
      (خطأ Redis لا يُرمى كاستثناء هنا ولا يوقف الطلب الأصلي أبدًا).
   4) نافذة كشف الإغراق الدوّارة تبقى بلا أي تغيير على globalThis
      (غير موزّعة وغير دائمة) — مقبول لأن الهدف مؤشر تقريبي سريع
      وليس سجلًا دائمًا، ولأن نطاق هذه المرحلة هو العدّاد اليومي فقط.

   التغيير الجوهري في هذا الإصدار (إضافة إلى نقل التخزين لـ Redis):
   أثناء نوبة إغراق نشطة (floodActive === true)، تتوقف الكتابة
   التفصيلية لعدّاد Redis اليومي لبقية الأحداث المرفوضة، تمامًا كما
   كانت تتوقف زيادة حاوية النافذة التفصيلية سابقًا — لتفادي إرسال
   استدعاء شبكي إلى Upstash عن كل طلب مرفوض في ذروة الهجوم، وهو
   بالضبط أسوأ توقيت لاستهلاك حصة الأوامر المجانية وزيادة زمن
   الاستجابة تحت الضغط. يُسجَّل reject_flood_detected في Redis مرة
   واحدة فقط عند لحظة تجاوز العتبة (لا يتكرر طوال استمرار النوبة)،
   بنفس المنطق المعتمد أصلًا.

   getSnapshot() أصبحت أيضًا async وتقرأ العدّاد اليومي من Redis
   مباشرة (HGETALL)، بدل globalThis، ليبقى مصدر البيانات موحّدًا
   وصحيحًا لأي استخدام مستقبلي (Owner Dashboard). لا تزال غير
   مُستدعاة من أي نقطة API في هذا الإصدار.
   ============================================================ */

import { CONFIG } from "./config.js";
import { redisHIncrByWithExpire, redisHGetAll } from "./redisStore.js";

const MONITOR_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 يومًا — نفس سياسة الاحتفاظ المعتمدة للعدّاد اليومي

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

// دالة نقية فقط لبناء اسم مفتاح يوم معيّن — إضافة توثيقية بحتة، بلا
// أي تغيير على recordEvent أو ALLOWED_EVENTS أو أي منطق آخر هنا.
export function monitorKeyForDate(dateStr) {
  return `dallini:monitor:${dateStr}`;
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

/**
 * يُحدِّث نافذة كشف الإغراق الدوّارة (globalThis، بلا تغيير)، ويكتب
 * reject_flood_detected في Redis مرة واحدة فقط عند لحظة تجاوز العتبة.
 * يُرجع "not_flooded" إن لم تُكتشف نوبة إغراق عند هذا الاستدعاء، حتى
 * يعرف recordEvent() هل يكتب العدّاد التفصيلي لهذا الحدث أم لا.
 */
async function recordWindowedRejection(key) {
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
      await redisHIncrByWithExpire(key, "reject_flood_detected", 1, MONITOR_TTL_SECONDS);
    }
    // لا نزيد عدّاد الحاوية التفصيلي طوال استمرار نوبة الإغراق — هذا
    // بالضبط ما يمنع تضخّم الأرقام التفصيلية بلا حد أعلى.
    return "flooded";
  }

  win.floodActive = false; // إعادة تسليح الكشف لنوبة إغراق مستقبلية محتملة
  bucket.count += 1;
  return "not_flooded";
}

/**
 * تسجيل وقوع حدث تقني — لا يقبل ولا يُخزّن أي شيء غير نوع الحدث نفسه.
 * لا ترمي أي استثناء أبدًا؛ فشلها الداخلي (بما فيه فشل الاتصال بـ
 * Redis عبر سياسة Fail-open في redisStore.js) لا يؤثر على الطلب
 * الأصلي مطلقًا.
 *
 * العدّاد اليومي (Redis) يعمل لكل الأحداث بلا استثناء، ما عدا أثناء
 * نوبة إغراق نشطة: عندها تتوقف الكتابة التفصيلية للأحداث الواردة في
 * REJECTION_EVENTS_FOR_FLOOD تحديدًا (راجع توثيق أعلى الملف)، ويبقى
 * reject_flood_detected هو المؤشر المجمّع الوحيد لتلك الفترة.
 */
export async function recordEvent(eventType) {
  try {
    if (!ALLOWED_EVENTS.includes(eventType)) return; // تجاهل صامت لأي قيمة غير معروفة

    const key = `dallini:monitor:${todayKeyUTC()}`;

    if (REJECTION_EVENTS_FOR_FLOOD.includes(eventType)) {
      const win = getWindowState();
      if (win.floodActive) {
        // نوبة إغراق نشطة بالفعل: لا كتابة تفصيلية إضافية — فقط تحديث
        // النافذة الدوّارة (لن تكتب Redis مجددًا لأن floodActive already true).
        await recordWindowedRejection(key);
        return;
      }
      await redisHIncrByWithExpire(key, eventType, 1, MONITOR_TTL_SECONDS);
      await recordWindowedRejection(key);
    } else {
      await redisHIncrByWithExpire(key, eventType, 1, MONITOR_TTL_SECONDS);
    }
  } catch {
    /* لا نكسر الطلب أبدًا بسبب فشل في المراقبة */
  }
}

/**
 * قراءة لقطة من الحالة الحالية (العدّاد اليومي من Redis + ملخّص
 * النافذة الدوّارة من الذاكرة) — للاستخدام الداخلي المستقبلي فقط
 * (نقطة Owner Dashboard). غير مُستدعاة من أي نقطة API في هذا الإصدار.
 *
 * ملاحظة Fail-open: إن تعذّر الوصول إلى Redis تُعاد counts كقاموس
 * فارغ {} بدل رمي استثناء، اتساقًا مع سياسة الفشل الصامت في بقية
 * هذا الملف وفي redisStore.js.
 */
export async function getSnapshot() {
  try {
    const win = getWindowState();
    const bucketMs = getWindowBucketMs();
    const currentSlot = Math.floor(Date.now() / bucketMs);
    const key = `dallini:monitor:${todayKeyUTC()}`;
    const counts = (await redisHGetAll(key)) || {};
    return {
      date: todayKeyUTC(),
      counts,
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
