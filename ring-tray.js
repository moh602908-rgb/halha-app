/* ============================================================
   ring-tray.js — صينية الرنين داخل الصفحة: ما أُطلق الآن + Snooze الأساسي (Free) + إيقاف
   ============================================================
   تعمل مع أي صفحة تحمل app-header.js. تستمع لحدث dallini:time-fired الذي تُطلقه voice-tts-web.js بعد حجز الإطلاق
   ذرّيًا، فتظهر للمستخدم حتى لو لم يُمنح إذن الإشعارات (الإشعار الأساسي لا يعتمد عليه وحده).
   Snooze للمنبّه والتذكير فقط (snoozeEntity)؛ لا اسم مستخدم هنا إطلاقًا (Free). لا شبكة، لا استيراد لـ app.js/ask.js/prompt.js/api/.

   نغمة المنبّه (Free): مرتبطة بحالة الرنين نفسها = عناصر هذه الصينية. تعمل ما دام فيها منبّه واحد على الأقل،
   وتتوقف فورًا عند «غفوة» (قبل انتظار قاعدة البيانات) أو «إيقاف» أو تفكيك الصينية. لا مؤقت ولا مصدر حقيقة ثانٍ:
   الصينية تتغذى فقط من حدث الإطلاق الذي يحجزه Time Core ذرّيًا، فتكرار tick لا ينشئ نغمتين (start متساوية القوة).
   إيقاف النغمة/إيقاف الصينية لا يلمس أي بيانات، فلا يفسد الدورة التالية.
   حدود الويب: النغمة تعمل والصفحة قادرة على التنفيذ فقط (ليست دليلًا على عمل المنبّه بعد إغلاقها).
   ============================================================ */

import { snoozeEntity } from "./organizer-time.js";
import { FIRED_EVENT_NAME } from "./voice-tts-web.js";
import { createAlarmTone } from "./alarm-tone.js";

export const SNOOZE_CHOICES = Object.freeze([5, 10, 15]);
export const TIME_CHANGED_EVENT = "dallini:time-changed";
const MAX_ITEMS = 5;
const KIND_LABELS = Object.freeze({ alarm: "منبّه", reminder: "تذكير", timer: "انتهى المؤقت", countdown: "انتهى العدّ التنازلي" });
const STYLE_ID = "ring-tray-style";
const CSS = `
.rt-item { background: #fff; color: #171B26; border: 1px solid #E3E8F2; border-inline-start: 5px solid #6C4CE0; border-radius: 14px; padding: 12px 14px; box-shadow: 0 6px 20px rgba(23, 27, 38, 0.1); }
.rt-item__kind { font-size: 12px; color: #5C6272; margin: 0 0 2px; }
.rt-item__title { font-size: 16px; font-weight: 800; margin: 0 0 10px; word-break: break-word; }
.rt-item__msg { font-size: 12.5px; color: #B2543A; margin: 0 0 8px; }
.rt-item__actions { display: flex; flex-wrap: wrap; gap: 6px; }
.rt-btn { border: 1px solid #E3E8F2; background: #F6F8FC; color: #12377D; border-radius: 10px; min-height: 38px; padding: 0 12px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit; }
.rt-btn--stop { background: #12377D; color: #fff; border-color: #12377D; }
`;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) { if (c != null) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
  return node;
}

/** يربط الصينية بالحاوية. يعيد دالة تفكيك. */
export function mountRingTray(container, { win = window, tone: toneOverride, snoozeFn = snoozeEntity } = {}) {
  if (!document.getElementById(STYLE_ID)) { const st = el("style", { id: STYLE_ID }); st.textContent = CSS; document.head.appendChild(st); }
  const items = new Map(); // event_id → { event, message }
  // onChange (استئناف الصوت بعد اللمسة) يحدّث التلميح فقط: إعادة بناء الأزرار بين الضغط والرفع تُضيّع النقرة.
  const tone = toneOverride || createAlarmTone({ env: win, onChange: () => refreshHint() });

  /** النغمة = دالة في حالة الرنين: تُشغَّل إن وُجد منبّه في الصينية، وتُوقف وإلا. */
  const ringingAlarm = () => [...items.values()].some((x) => x.event.entity_kind === "alarm");
  function syncTone() { if (ringingAlarm()) tone.start(); else tone.stop(); }

  function render() {
    syncTone();
    container.innerHTML = "";
    for (const { event, message } of items.values()) {
      const canSnooze = event.entity_kind === "alarm" || event.entity_kind === "reminder";
      const actions = el("div", { class: "rt-item__actions" });
      if (canSnooze) {
        for (const m of SNOOZE_CHOICES) {
          actions.appendChild(el("button", { class: "rt-btn", type: "button", "data-snooze": String(m), onclick: () => onSnooze(event, m) }, `غفوة ${m} د`));
        }
      }
      actions.appendChild(el("button", { class: "rt-btn rt-btn--stop", type: "button", "data-dismiss": "1", onclick: () => { items.delete(event.event_id); render(); } }, "إيقاف"));
      container.appendChild(el("div", { class: "rt-item", "data-event-id": event.event_id },
        el("p", { class: "rt-item__kind" }, KIND_LABELS[event.entity_kind] || "تنبيه"),
        el("p", { class: "rt-item__title" }, event.title),
        message ? el("p", { class: "rt-item__msg" }, message) : null,
        actions));
    }
    refreshHint();
  }

  /** تلميح الحجب: يُضاف/يُزال وحده دون المساس ببقية العناصر. */
  function refreshHint() {
    const existing = container.querySelector('[data-role="tone-hint"]');
    const need = ringingAlarm() && tone.state() === "blocked";
    if (need && !existing) container.appendChild(el("p", { class: "rt-item__msg", "data-role": "tone-hint" }, "المتصفح يمنع الصوت قبل لمسة: المس الشاشة لتفعيل نغمة المنبّه."));
    else if (!need && existing) existing.remove();
  }

  async function onSnooze(event, minutes) {
    if (event.entity_kind === "alarm") tone.stop(); // فورًا عند الضغط؛ إن تعذّر التأجيل يعيد render تشغيلها
    try {
      const r = await snoozeFn(event.entity_id, minutes, { originDueAt: Date.parse(event.target_at) });
      if (r.applied) { items.delete(event.event_id); }
      else {
        const slot = items.get(event.event_id);
        if (slot) slot.message = r.reason === "next_cycle" ? "لا يمكن تأجيل المنبّه إلى ما بعد موعده القادم." : "تعذّر التأجيل.";
      }
    } catch {
      const slot = items.get(event.event_id); if (slot) slot.message = "تعذّر التأجيل.";
    }
    render();
    win.dispatchEvent(new CustomEvent(TIME_CHANGED_EVENT));
  }

  const onFired = (ev) => {
    const e = ev.detail;
    if (!e || !e.event_id) return;
    items.set(e.event_id, { event: e, message: "" });
    while (items.size > MAX_ITEMS) items.delete(items.keys().next().value);
    render();
  };
  win.addEventListener(FIRED_EVENT_NAME, onFired);
  return () => { win.removeEventListener(FIRED_EVENT_NAME, onFired); items.clear(); tone.stop(); container.innerHTML = ""; };
}
