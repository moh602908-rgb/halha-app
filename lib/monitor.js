/* ============================================================
   lib/monitor.js — المراقبة الأساسية للمالك (الإصدار الأول)
   ============================================================
   الهدف: "عين بسيطة" على حالة النظام — عدّادات مجمّعة فقط، بدون أي
   محتوى أو معلومة يمكن ربطها بمستخدم معيّن.

   قيود التصميم (صارمة ومقصودة):
   1) recordEvent() تقبل معاملًا واحدًا فقط من قائمة مغلقة (Enum) —
      لا يوجد أي حقل حرّ (req, details, metadata...) يمكن أن يحمل
      بيانات شخصية عبره، حتى بالخطأ من تعديل مستقبلي.
   2) Fail-silent كامل: أي خطأ داخلي يُلتقط ولا يُعاد رميه أبدًا،
      فلا يمكن لهذا الملف أن يُسقط أو يُبطئ طلب المستخدم الأصلي.
   3) بدون await وبدون أي I/O: عملية زيادة عدّاد في الذاكرة فقط،
      تنفيذ فوري متزامن.
   4) نفس نمط التخزين المعتمد أصلًا في lib/ratelimit.js
      (globalThis.__dallini_global_usage) — غير موزّع وغير دائم،
      يُصفَّر يوميًا ويُعاد ضبطه عند إعادة تشغيل أي نسخة من الخادم.
      هذا مقبول هنا لأن الهدف مؤشر تقريبي وليس سجلًا دائمًا.

   لا توجد في هذا الإصدار أي نقطة عرض (API) لهذه البيانات — تُقرأ
   لاحقًا (عند الحاجة) يدويًا عبر Vercel Runtime Logs فقط.
   ============================================================ */

// قائمة الأحداث المسموحة حصرًا — أي قيمة خارج هذه القائمة تُتجاهل بصمت.
const ALLOWED_EVENTS = Object.freeze([
  "too_fast",
  "quota_limit",
  "origin_block",
  "provider_error",
  "validation_error"
]);

function todayKeyUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getMonitorState() {
  if (!globalThis.__dallini_monitor) {
    globalThis.__dallini_monitor = {
      date: todayKeyUTC(),
      counts: {
        too_fast: 0,
        quota_limit: 0,
        origin_block: 0,
        provider_error: 0,
        validation_error: 0
      }
    };
  }
  const state = globalThis.__dallini_monitor;
  const today = todayKeyUTC();
  if (state.date !== today) {
    state.date = today;
    state.counts = {
      too_fast: 0,
      quota_limit: 0,
      origin_block: 0,
      provider_error: 0,
      validation_error: 0
    };
  }
  return state;
}

/**
 * تسجيل وقوع حدث تقني — لا يقبل ولا يُخزّن أي شيء غير نوع الحدث نفسه.
 * لا ترمي أي استثناء أبدًا؛ فشلها الداخلي لا يؤثر على الطلب الأصلي.
 */
export function recordEvent(eventType) {
  try {
    if (!ALLOWED_EVENTS.includes(eventType)) return; // تجاهل صامت لأي قيمة غير معروفة
    const state = getMonitorState();
    state.counts[eventType] += 1;
  } catch {
    /* لا نكسر الطلب أبدًا بسبب فشل في المراقبة */
  }
}

/**
 * قراءة لقطة من الحالة الحالية — للاستخدام الداخلي المستقبلي فقط.
 * غير مُستدعاة من أي نقطة API في هذا الإصدار.
 */
export function getSnapshot() {
  try {
    const state = getMonitorState();
    return { date: state.date, counts: { ...state.counts } };
  } catch {
    return null;
  }
}
