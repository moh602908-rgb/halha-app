/* ============================================================
   alarm-tone.js — نغمة المنبّه المحلية (Free): توليد في الذاكرة + تكرار بحلقة صوتية، بلا ملفات ولا شبكة
   ============================================================
   - ليست مؤقتًا ولا مجدولًا: لا setInterval/setTimeout هنا إطلاقًا. التكرار بخاصية loop لمصدر AudioBuffer واحد.
     التوقيت الوحيد للمنبّه يبقى في Time Core، والنغمة مجرد "مخرَج" لحالة الرنين الحالية (ring-tray.js).
   - لا TTS ولا Premium: نغمة صافية (موجة جيبية بنمط بيب-بيب-بيب ثم صمت) بغلاف ناعم لتفادي النقرات.
   - start() / stop() متساويتا القوة (idempotent): استدعاؤهما أكثر من مرة لا ينشئ نغمتين ولا يرمي.
   - سياسة التشغيل التلقائي في المتصفح: لا صوت قبل لمسة واحدة على الصفحة. إن حُجبت النغمة تصبح الحالة "blocked"،
     وأول لمسة/ضغطة/مفتاح تستأنف السياق تلقائيًا (واستدعاء onChange لتحديث التلميح).
   - تعمل فقط والصفحة قادرة على التنفيذ؛ لا تدل على أن المنبّه يعمل بعد إغلاق الصفحة (حدود الويب في الواجهة كما هي).
   لا fetch، لا استيراد لأي ملف آخر.
   ============================================================ */

export const TONE_PATTERN_SECONDS = 1.6;
const GESTURE_EVENTS = Object.freeze(["pointerdown", "touchstart", "keydown", "click"]);

/** يملأ مخزنًا بنمط: ثلاث نبضات 880Hz (0.18ث) تفصلها 0.1ث ثم صمت حتى 1.6ث؛ غلاف أسّي ناعم عند البداية والنهاية. */
export function fillTonePattern(data, sampleRate) {
  const beep = Math.floor(0.18 * sampleRate), gap = Math.floor(0.1 * sampleRate), fade = Math.floor(0.012 * sampleRate);
  data.fill(0);
  for (let b = 0; b < 3; b++) {
    const start = b * (beep + gap);
    for (let i = 0; i < beep && start + i < data.length; i++) {
      const env = Math.min(1, i / fade, (beep - i) / fade);
      data[start + i] = 0.6 * env * Math.sin((2 * Math.PI * 880 * i) / sampleRate);
    }
  }
}

/**
 * env: يوفّر AudioContext (أو webkitAudioContext) وaddEventListener/removeEventListener للمستمعات.
 * onChange: يُستدعى عند تغيّر الحالة بسبب استئناف السياق بعد لمسة.
 * state(): "stopped" | "playing" | "blocked".
 */
export function createAlarmTone({ env = globalThis, onChange = () => {} } = {}) {
  let ctx = null, source = null, gain = null, wanted = false, listening = false;

  const Ctor = () => env.AudioContext || env.webkitAudioContext || null;

  function state() {
    if (!wanted || !source) return "stopped";
    return ctx && ctx.state === "running" ? "playing" : "blocked";
  }

  function onGesture() {
    if (!wanted || !ctx) return;
    const done = () => { try { onChange(state()); } catch { /* مستمع الواجهة لا يكسر الصوت */ } };
    try { const r = ctx.resume(); if (r && r.then) r.then(done, () => {}); else done(); } catch { /* تجاهل */ }
  }
  function listen(on) {
    if (on === listening) return;
    listening = on;
    for (const ev of GESTURE_EVENTS) { try { on ? env.addEventListener(ev, onGesture, true) : env.removeEventListener(ev, onGesture, true); } catch { /* تجاهل */ } }
  }

  function start() {
    wanted = true;
    if (source) return state(); // متساوية القوة: لا مصدر ثانٍ ولا إعادة استئناف (المستمع يتولى الحجب)
    const C = Ctor();
    if (!C) return "blocked";
    try {
      if (!ctx) ctx = new C();
      const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * TONE_PATTERN_SECONDS), ctx.sampleRate);
      fillTonePattern(buffer.getChannelData(0), ctx.sampleRate);
      gain = ctx.createGain(); gain.gain.value = 0.9;
      source = ctx.createBufferSource(); source.buffer = buffer; source.loop = true;
      source.connect(gain); gain.connect(ctx.destination);
      source.start();
      if (ctx.state !== "running") { try { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } catch { /* الحجب يُعالج بالمستمع */ } }
    } catch { source = null; return "blocked"; }
    listen(true);
    return state();
  }

  function stop() {
    wanted = false;
    listen(false);
    if (source) {
      try { source.stop(); } catch { /* أُوقف سابقًا */ }
      try { source.disconnect(); } catch { /* تجاهل */ }
      source = null;
    }
    if (gain) { try { gain.disconnect(); } catch { /* تجاهل */ } gain = null; }
    return "stopped";
  }

  return { start, stop, state, isPlaying: () => state() === "playing" };
}
