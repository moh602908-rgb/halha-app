/* ============================================================
   voice-tts-web.js — طبقة التنفيذ في الصفحة (فورجراوند): صوت + إشعار
   ============================================================
   يعمل فقط والصفحة مفتوحة. لكن السببين مختلفان تقنيًا، وهذا فرق مهم
   وليس تفصيلًا لفظيًا (تحقّق مسجَّل، لا افتراض):

   1) الصوت (speechSynthesis): قيد صارم في واجهة المتصفح نفسها، لا حل
      بديل له على الويب مطلقًا. الواجهة معرَّفة فقط على Window، وغير
      موجودة إطلاقًا في ServiceWorkerGlobalScope — فحتى لو أعدنا كتابة
      هذا الملف بالكامل ليعمل من داخل sw.js، السطر الذي يستدعي
      speechSynthesis سيفشل فورًا لأن الكائن غير موجود هناك أصلًا.

   2) الإشعار النصي (self.registration.showNotification): هذه بذاتها
      **لا** تحتاج صفحة مفتوحة، وتعمل من داخل Service Worker بمفرده —
      هذا بالضبط أساس عمل إشعارات Push على الويب (صفحة مغلقة تمامًا،
      وحدث push يوقظ الـSW، فيستدعي showNotification بنجاح). القيد هنا
      ليس في الدالة نفسها، بل في آلية إطلاقنا الفعلية: sw.js (مستمعاته
      الأربعة فقط install/activate/fetch/message — لا push ولا
      periodicsync) لا يستدعي showNotification إلا داخل مستمع
      "message"، وهذا المستمع لا يُستثار إلا بـpostMessage صريح يصل من
      صفحة حيّة. المُرسِل الوحيد لهذه الرسالة هو دالة notify() أدناه،
      المستدعاة من tick() المُشغَّلة بـsetInterval على الصفحة نفسها
      (startVoiceReminderLoop، أسفل هذا الملف) — فإغلاق التبويب يوقف
      هذا الـsetInterval فورًا، فلا يُرسَل postMessage، فلا يستيقظ
      sw.js، فلا يُستدعى showNotification، رغم أن الدالة قادرة تقنيًا
      على العمل بمفردها لو وُجد محفِّز مستقل عن الصفحة.

   لذلك، في البنية الحالية، الإشعار أيضًا لا يُطلق بعد إغلاق الصفحة —
   ليس بسبب قيد في showNotification ذاتها، بل لأنه لا يوجد حاليًا
   محفِّز مستقل عن الصفحة (push يحتاج خادمًا يرسل للـSW حتى والصفحة
   مغلقة، وهذا التطبيق بلا خادم ولا تخزين خادم لمحتوى المستخدم بقرار
   صريح؛ periodicsync دعمه في المتصفحات ضيق جدًا ويحتاج شروط تفاعل
   صارمة، فلم يُعتمد الآن). النتيجة العملية لهذا الفارق: الإشعار (حين
   يُطلق فعلًا) يبقى ظاهرًا في تراي النظام حتى لو أُغلق التبويب بعد
   لحظة postMessage مباشرة — بخلاف الصوت الذي ينقطع فور إغلاق الصفحة —
   لكن كلاهما يتطلب صفحة مفتوحة *لحظة* الإطلاق نفسها. سدّ هذه الفجوة
   فعليًا (رنين موثوق بعد إغلاق التطبيق تمامًا) هو بالضبط ما تبرره
   طبقة Android لاحقًا (AlarmManager + TTS أصلي)، لا حل ويب صادق له.

   setInterval هنا للعرض/الفحص الدوري فقط على الصفحة، وليس مصدر الحقيقة:
   كل قرار "هل حان الوقت؟" يقارن fire_at المطلق (من organizer-exporter.js)
   بـDate.now() في كل دورة، فإغلاق التبويب وإعادة فتحه لا يفقد أي حدث
   ضمن نافذة الفحص.
   لا fetch، لا استيراد لـ app.js/ask.js/prompt.js/api/.
   ============================================================ */

import { listUpcomingEvents, getVoiceTextForEvent } from "./organizer-exporter.js";
import { markFired } from "./organizer-time.js";

const POLL_INTERVAL_MS = 5000;
const LOOKAHEAD_MS = 60 * 1000; // نافذة فحص قصيرة: نبحث دائمًا عمّا "حان وقته الآن أو خلال دقيقة"
const FIREABLE_KINDS = Object.freeze(["reminder", "timer", "countdown"]); // alarm يتكرر، لا "ينتهي" بذاته

/** تشغيل نطق نص عبر speechSynthesis المحلي؛ لا شبكة، لا تخزين صوت. */
function speak(text) {
  if (typeof window === "undefined" || !window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") return false;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ar";
  window.speechSynthesis.speak(u);
  return true;
}

/** طلب عرض إشعار نصي عبر sw.js (يعمل بلا صوت هناك دائمًا). بلا أثر إن لم يوجد SW نشط. */
function notify(title, eventId) {
  if (typeof navigator === "undefined" || !navigator.serviceWorker || !navigator.serviceWorker.controller) return false;
  navigator.serviceWorker.controller.postMessage({ type: "organizer_show_reminder_notification", title, tag: eventId });
  return true;
}

/**
 * يبدأ الحلقة الدورية. يعيد دالة إيقاف (لتفكيك المستمع عند إغلاق الصفحة/الاختبار).
 * handledThisSession: ذاكرة صفحة بسيطة (لا تخزين) لمنع معالجة نفس event_id مرتين في نفس الجلسة —
 * آمنة لأن event_id حتمي: إعادة تشغيل الصفحة تعيد بناء الذاكرة، وأي حدث لم يُعلَّم منتهيًا فعليًا
 * (لم يُستدعَ markFired له) سيظل يظهر من Exporter فيُعاد التعامل معه، وهذا هو السلوك الصحيح.
 */
export function startVoiceReminderLoop({ speakFn = speak, notifyFn = notify } = {}) {
  const handledThisSession = new Set();
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const now = new Date();
      const events = await listUpcomingEvents(new Date(now.getTime() - POLL_INTERVAL_MS), new Date(now.getTime() + LOOKAHEAD_MS));
      for (const e of events) {
        if (handledThisSession.has(e.event_id)) continue;
        if (new Date(e.fire_at).getTime() > now.getTime()) continue; // لم يحن وقته فعليًا بعد
        handledThisSession.add(e.event_id);

        if (e.voice_eligible) {
          // eslint-disable-next-line no-await-in-loop
          const text = await getVoiceTextForEvent(e);
          if (text) speakFn(text);
        }
        notifyFn(e.title, e.event_id);

        if (FIREABLE_KINDS.includes(e.entity_kind)) {
          // eslint-disable-next-line no-await-in-loop
          try { await markFired(e.entity_id); } catch { /* لا نكسر الحلقة لأجل خطأ تعليم فردي */ }
        }
      }
    } catch { /* لا نكسر الحلقة الدورية لأجل خطأ نداء واحد؛ المحاولة التالية تلتقط الحدث نفسه (event_id ثابت) */ }
  }

  const timer = setInterval(tick, POLL_INTERVAL_MS);
  tick(); // فحص فوري عند البدء، لا انتظار أول دورة
  return () => { stopped = true; clearInterval(timer); };
}
