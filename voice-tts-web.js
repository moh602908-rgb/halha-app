/* ============================================================
   voice-tts-web.js — طبقة التنفيذ في الصفحة (فورجراوند): صوت + إشعار
   ============================================================
   يعمل فقط والصفحة مفتوحة (حتى لو في الخلفية ضمن المتصفح، مع احتمال تأخير/تجميد من المتصفح).
   لا يعمل بعد إغلاق الصفحة. السببان مختلفان تقنيًا (تحقّق مسجَّل، لا افتراض):

   1) الصوت (speechSynthesis): قيد صارم في واجهة المتصفح نفسها؛ الواجهة معرَّفة على Window فقط
      وغير موجودة في ServiceWorkerGlobalScope، فلا بديل ويب لها.

   2) الإشعار النصي (self.registration.showNotification): هذه بذاتها لا تحتاج صفحة مفتوحة،
      لكن محفِّزنا الوحيد (tick المُشغَّل بـsetInterval على الصفحة → postMessage → sw.js) يموت بإغلاق الصفحة.
      لا push (يحتاج خادمًا، وهذا التطبيق بلا خادم بقرار صريح) ولا periodicsync (دعم ضيق وشروط صارمة).
      فالإشعار أيضًا لا يُطلق بعد إغلاق الصفحة — ليس لقيد في showNotification بل لغياب محفِّز مستقل عن الصفحة.
      سدّ هذه الفجوة بموثوقية (AlarmManager + TTS أصلي) هو مبرر طبقة Android لاحقًا، لا حل ويب صادق له.

   الفصل Free/Premium هنا:
   - Free: الإشعار النصي الأساسي (عنوان العنصر + نص عام بلا اسم المستخدم) + البانر داخل الصفحة. لا يمرّ من buildVoiceText.
   - Premium: الصوت الذكي فقط، ونقطة التحكم الوحيدة فيه buildVoiceText() (organizer-voice.js).

   قرار "هل حان الوقت؟" يأتي من listDueEvents() (organizer-exporter.js) وفق سياسة الفائت، لا من نافذة قصيرة:
   timestamps مطلقة، والحجز الذرّي claimFiring/claimSnoozeFire يمنع التكرار (حتى مع إعادة تحميل الصفحة أو تبويبين).
   Page Visibility: عند عودة الصفحة للظهور (visibilitychange/pageshow/focus) يُجرى tick فورًا.
   لا fetch، لا استيراد لـ app.js/ask.js/prompt.js/api/.
   ============================================================ */

import { listDueEvents, getVoiceTextForEvent } from "./organizer-exporter.js";
import { markFired, claimFiring, claimSnoozeFire, sweepStaleState } from "./organizer-time.js";

const POLL_INTERVAL_MS = 5000;
const FINISH_KINDS = Object.freeze(["reminder", "timer", "countdown"]); // alarm المتكرر لا "ينتهي" بذاته
export const FIRED_EVENT_NAME = "dallini:time-fired";
export const NOTIFICATION_MESSAGE_TYPE = "organizer_show_reminder_notification";

/** نص الإشعار الأساسي (Free): عام بحسب النوع، بلا اسم المستخدم إطلاقًا. */
const NOTIFICATION_BODY_BY_KIND = Object.freeze({
  alarm: "منبّه",
  reminder: "تذكير",
  timer: "انتهى المؤقت",
  countdown: "انتهى العدّ التنازلي",
});

/* ================= حالة إذن الإشعارات ================= */

/** granted | default | denied | unsupported (عدم دعم Notification أو Service Worker = unsupported). */
export function getNotificationPermissionState(env = globalThis) {
  const N = env && env.Notification;
  const nav = env && env.navigator;
  if (!N || !nav || !("serviceWorker" in nav)) return "unsupported";
  const p = N.permission;
  return p === "granted" || p === "denied" || p === "default" ? p : "unsupported";
}

/**
 * يطلب الإذن — يجب أن تُستدعى من معالج نقرة المستخدم فقط (زر واضح). لا تُستدعى تلقائيًا في أي مكان.
 * لا تطلب إلا عندما تكون الحالة default (denied لا يمكن إعادة طلبها برمجيًا).
 */
export async function requestNotificationPermission(env = globalThis) {
  if (getNotificationPermissionState(env) !== "default") return getNotificationPermissionState(env);
  try {
    await new Promise((resolve) => {
      const r = env.Notification.requestPermission(resolve); // صيغة الاستدعاء القديمة
      if (r && typeof r.then === "function") r.then(resolve, resolve); // الصيغة الحديثة (Promise)
    });
  } catch { /* نعيد الحالة الفعلية أدناه */ }
  return getNotificationPermissionState(env);
}

/** مؤشر حي: يستدعي onChange(state) فورًا ثم عند أي تغيّر (permissions.onchange + عودة الصفحة + فحص دوري خفيف). */
export function watchNotificationPermission(onChange, env = globalThis, { pollMs = 3000 } = {}) {
  let last = getNotificationPermissionState(env);
  const check = () => { const s = getNotificationPermissionState(env); if (s !== last) { last = s; onChange(s); } };
  onChange(last);
  let permStatus = null;
  try {
    const q = env.navigator && env.navigator.permissions && env.navigator.permissions.query({ name: "notifications" });
    if (q && q.then) q.then((p) => { permStatus = p; p.addEventListener("change", check); }).catch(() => {});
  } catch { /* بعض المتصفحات لا تدعم الاستعلام */ }
  const doc = env.document, win = env.window || env;
  if (doc && doc.addEventListener) doc.addEventListener("visibilitychange", check);
  if (win && win.addEventListener) win.addEventListener("focus", check);
  const timer = setInterval(check, pollMs);
  return () => {
    clearInterval(timer);
    if (doc && doc.removeEventListener) doc.removeEventListener("visibilitychange", check);
    if (win && win.removeEventListener) win.removeEventListener("focus", check);
    if (permStatus) permStatus.removeEventListener("change", check);
  };
}

/* ================= الصوت والإشعار ================= */

/** تشغيل نطق نص عبر speechSynthesis المحلي؛ لا شبكة، لا تخزين صوت. */
function speak(text) {
  if (typeof window === "undefined" || !window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") return false;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ar";
  window.speechSynthesis.speak(u);
  return true;
}

/**
 * طلب عرض إشعار نصي عبر sw.js (message → SW → showNotification). لا يُرسَل شيء إلا إذا كان الإذن granted.
 * الحمولة: عنوان العنصر + نص عام حسب النوع + tag=event_id. لا display_name إطلاقًا (Free).
 */
export async function notify(event, env = globalThis) {
  if (getNotificationPermissionState(env) !== "granted") return false;
  const sw = env.navigator.serviceWorker;
  let target = sw.controller;
  if (!target) {
    try { const reg = await sw.getRegistration(); target = reg && reg.active; } catch { /* لا SW نشط */ }
  }
  if (!target) return false;
  target.postMessage({
    type: NOTIFICATION_MESSAGE_TYPE,
    title: event.title,
    tag: event.event_id,
    body: NOTIFICATION_BODY_BY_KIND[event.entity_kind] || "تذكير",
  });
  return true;
}

/* ================= اختبار النطق المحلي (Free) ================= */

export const TTS_TEST_PHRASE = "اختبار الصوت. إن سمعت هذه الجملة فالنطق يعمل على جهازك.";

/**
 * يختبر speechSynthesis المحلي فقط (لا شبكة، لا تخزين). يجب أن يُستدعى من نقرة المستخدم (قيد المتصفح).
 * يعيد دائمًا: { status, ok, arabicVoice, voices, error? } حيث status ∈
 *   "unsupported" (لا واجهة نطق) | "ok" (بدأ النطق، وفيه صوت عربي) | "ok_no_arabic" (بدأ النطق لكن بلا صوت عربي مثبّت)
 *   | "error" (أبلغ المحرك خطأ) | "no_start" (لم يبدأ النطق خلال المهلة: غالبًا لا محرك نطق على الجهاز).
 */
export function testSpeech(env = globalThis, { timeoutMs = 4000 } = {}) {
  const synth = env && env.speechSynthesis;
  const Utter = env && env.SpeechSynthesisUtterance;
  if (!synth || typeof Utter !== "function") return Promise.resolve({ status: "unsupported", ok: false, arabicVoice: false, voices: 0 });
  return new Promise((resolve) => {
    let settled = false;
    const voicesInfo = () => {
      let list = [];
      try { list = synth.getVoices ? Array.from(synth.getVoices()) : []; } catch { /* تجاهل */ }
      return { voices: list.length, arabicVoice: list.some((v) => /^ar/i.test(v.lang || "")) };
    };
    const done = (status, ok, extra = {}) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ status, ok, ...voicesInfo(), ...extra }); };
    const u = new Utter(TTS_TEST_PHRASE);
    u.lang = "ar";
    u.onstart = () => { const v = voicesInfo(); done(v.arabicVoice ? "ok" : "ok_no_arabic", true); };
    u.onerror = (ev) => done("error", false, { error: (ev && ev.error) || "unknown" });
    const timer = setTimeout(() => done("no_start", false), timeoutMs);
    try { if (synth.cancel) synth.cancel(); synth.speak(u); } catch (e) { done("error", false, { error: String((e && e.message) || e) }); }
  });
}

function defaultOnFired(e) {
  if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
    window.dispatchEvent(new CustomEvent(FIRED_EVENT_NAME, { detail: e }));
  }
}

/**
 * فحص واحد لما استحق الآن (يُستدعى من الحلقة، ومباشرةً في الاختبارات). يعيد الأحداث التي أُطلقت فعليًا.
 * الحجز الذرّي قبل أي أثر جانبي (صوت/إشعار): أول من يحجز ينفّذ، وغيره يتخطى — فتكرار tick لا يكرر الإطلاق.
 */
export async function runDueCheck({ speakFn = speak, notifyFn = notify, onFired = defaultOnFired, now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const fired = [];
  try { await sweepStaleState(nowMs); } catch { /* التنظيف لا يمنع الإطلاق */ }
  const events = await listDueEvents(new Date(nowMs));
  for (const e of events) {
    const won = e.snooze
      ? await claimSnoozeFire(e.entity_id, Date.parse(e.fire_at), { now: nowMs })
      : await claimFiring(e.entity_id, e.event_id, { now: nowMs, finish: e.entity_kind === "alarm" && !e.recurrence_rule });
    if (!won) continue;

    if (e.voice_eligible) {
      try { const text = await getVoiceTextForEvent(e); if (text) speakFn(text); } catch { /* الصوت إضافة؛ لا يكسر الإشعار */ }
    }
    try { await notifyFn(e); } catch { /* الإشعار لا يكسر الحلقة */ }
    if (!e.snooze && FINISH_KINDS.includes(e.entity_kind)) {
      try { await markFired(e.entity_id); } catch { /* لا نكسر الحلقة لأجل خطأ تعليم فردي */ }
    }
    fired.push(e);
    try { onFired(e); } catch { /* مستمع الواجهة لا يكسر الحلقة */ }
  }
  return fired;
}

/**
 * يبدأ الحلقة الدورية. يعيد دالة إيقاف (لتفكيك المؤقت والمستمعين عند إغلاق الصفحة/الاختبار).
 * setInterval للفحص فقط وليس مصدر الحقيقة؛ Page Visibility: tick فور عودة الصفحة.
 */
export function startVoiceReminderLoop({ speakFn, notifyFn, onFired, pollMs = POLL_INTERVAL_MS, env = globalThis } = {}) {
  let stopped = false;
  let inFlight = false;
  const opts = {};
  if (speakFn) opts.speakFn = speakFn;
  if (notifyFn) opts.notifyFn = notifyFn;
  if (onFired) opts.onFired = onFired;

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try { await runDueCheck({ ...opts, now: new Date() }); } catch { /* المحاولة التالية تلتقط الحدث نفسه */ }
    finally { inFlight = false; }
  }

  const doc = env.document, win = env.window || env;
  const onVisible = () => { if (!doc || !doc.hidden) tick(); };
  const timer = setInterval(tick, pollMs);
  if (doc && doc.addEventListener) doc.addEventListener("visibilitychange", onVisible);
  if (win && win.addEventListener) { win.addEventListener("pageshow", onVisible); win.addEventListener("focus", onVisible); }
  tick(); // فحص فوري عند البدء، لا انتظار أول دورة
  return () => {
    stopped = true; clearInterval(timer);
    if (doc && doc.removeEventListener) doc.removeEventListener("visibilitychange", onVisible);
    if (win && win.removeEventListener) { win.removeEventListener("pageshow", onVisible); win.removeEventListener("focus", onVisible); }
  };
}
