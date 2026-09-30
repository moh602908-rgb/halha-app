/* ============================================================
   time-ui.js — صفحة منظومة الوقت (منبّه/مؤقت/عدّ تنازلي/تذكيرات)
   ============================================================
   لا استيراد لـ app.js/ask.js/prompt.js/api/. العرض يُعاد اشتقاقه دوريًا
   من target_at/fire_at (setInterval هنا للعرض فقط، ليس مصدر الحقيقة —
   انظر organizer-time.js). يبدأ أيضًا حلقة التذكير الصوتي (voice-tts-web.js)
   لأنها تعمل فقط والصفحة مفتوحة.
   ============================================================ */

import {
  listEntities, deleteEntity,
  createAlarm, setAlarmEnabled, nextAlarmFireAt,
  createTimer, createCountdown, pauseTimer, resumeTimer, cancelTimer, remainingMs,
  createReminder,
} from "./organizer-time.js";
import { startVoiceReminderLoop } from "./voice-tts-web.js";

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_LABELS = { SU: "أحد", MO: "اثنين", TU: "ثلاثاء", WE: "أربعاء", TH: "خميس", FR: "جمعة", SA: "سبت" };
const REFRESH_MS = 1000;

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

function fmtRemaining(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p2 = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${p2(h)}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`;
}

async function renderAlarms(container) {
  container.innerHTML = "";
  container.appendChild(el("h2", { class: "section-title" }, "المنبّه"));
  const alarms = await listEntities("alarm");
  for (const a of alarms) {
    const next = nextAlarmFireAt(a);
    const row = el("div", { class: "row item-row" },
      el("div", {}, el("strong", {}, a.title), el("div", { class: "hint" }, a.time + (a.days && a.days.length ? " · " + a.days.map((d) => DAY_LABELS[d]).join("، ") : "") + (next ? " · القادم: " + next.toLocaleString("ar") : ""))),
      el("input", { type: "checkbox", ...(a.enabled ? { checked: "checked" } : {}), onchange: (ev) => setAlarmEnabled(a.id, ev.target.checked).then(() => renderAlarms(container)) }),
      el("button", { class: "btn btn--ghost", onclick: () => deleteEntity(a.id).then(() => renderAlarms(container)) }, "حذف")
    );
    container.appendChild(row);
  }
  const titleInput = el("input", { class: "input", type: "text", placeholder: "عنوان المنبّه" });
  const timeInput = el("input", { class: "input", type: "time" });
  container.appendChild(el("div", { class: "form-row" }, titleInput, timeInput,
    el("button", { class: "btn", onclick: async () => {
      if (!titleInput.value.trim() || !timeInput.value) return;
      await createAlarm({ title: titleInput.value, time: timeInput.value });
      titleInput.value = ""; timeInput.value = "";
      renderAlarms(container);
    } }, "+ إضافة منبّه")
  ));
}

async function renderDurationSection(container, kind, title, createFn) {
  container.innerHTML = "";
  container.appendChild(el("h2", { class: "section-title" }, title));
  const items = await listEntities(kind);
  const now = Date.now();
  for (const r of items) {
    if (r.status === "cancelled") continue;
    const remaining = remainingMs(r, now);
    const row = el("div", { class: "row item-row", "data-id": r.id },
      el("div", {}, el("strong", {}, r.title), el("div", { class: "hint timer-remaining" }, r.status === "fired" ? "انتهى" : fmtRemaining(remaining))),
      el("div", { class: "actions" },
        r.status === "running" ? el("button", { class: "btn btn--ghost", onclick: () => pauseTimer(r.id).then(() => renderDurationSection(container, kind, title, createFn)) }, "إيقاف") : null,
        r.status === "paused" ? el("button", { class: "btn btn--ghost", onclick: () => resumeTimer(r.id).then(() => renderDurationSection(container, kind, title, createFn)) }, "استئناف") : null,
        (r.status === "running" || r.status === "paused") ? el("button", { class: "btn btn--ghost", onclick: () => cancelTimer(r.id).then(() => renderDurationSection(container, kind, title, createFn)) }, "إلغاء") : null,
        el("button", { class: "btn btn--ghost", onclick: () => deleteEntity(r.id).then(() => renderDurationSection(container, kind, title, createFn)) }, "حذف")
      )
    );
    container.appendChild(row);
  }
  const titleInput = el("input", { class: "input", type: "text", placeholder: "العنوان" });
  const minutesInput = el("input", { class: "input", type: "number", min: "1", placeholder: "دقائق" });
  container.appendChild(el("div", { class: "form-row" }, titleInput, minutesInput,
    el("button", { class: "btn", onclick: async () => {
      const mins = Number(minutesInput.value);
      if (!titleInput.value.trim() || !(mins > 0)) return;
      await createFn({ title: titleInput.value, duration_ms: mins * 60 * 1000 });
      titleInput.value = ""; minutesInput.value = "";
      renderDurationSection(container, kind, title, createFn);
    } }, "+ بدء")
  ));
}

async function renderReminders(container) {
  container.innerHTML = "";
  container.appendChild(el("h2", { class: "section-title" }, "التذكيرات"));
  const items = await listEntities("reminder");
  for (const r of items) {
    container.appendChild(el("div", { class: "row item-row" },
      el("div", {}, el("strong", {}, r.title), el("div", { class: "hint" }, `مرتبط بموعد: ${r.occ_key} · قبله بـ ${r.fire_offset_min} دقيقة`)),
      el("button", { class: "btn btn--ghost", onclick: () => deleteEntity(r.id).then(() => renderReminders(container)) }, "حذف")
    ));
  }
  container.appendChild(el("div", { class: "hint" }, "تُضاف التذكيرات المرتبطة بموعد تلقائيًا من صفحة اليوم عند تحديد وقت التذكير."));
}

async function boot() {
  const root = document.getElementById("time-root");
  if (!root) return;
  root.appendChild(el("a", { class: "back-link", href: "today.html" }, "‹ العودة إلى اليوم"));
  root.appendChild(el("h1", { class: "page-title" }, "منظومة الوقت"));

  const alarmsBox = el("section", { class: "card" }); root.appendChild(alarmsBox);
  const timersBox = el("section", { class: "card" }); root.appendChild(timersBox);
  const countdownsBox = el("section", { class: "card" }); root.appendChild(countdownsBox);
  const remindersBox = el("section", { class: "card" }); root.appendChild(remindersBox);

  await renderAlarms(alarmsBox);
  await renderDurationSection(timersBox, "timer", "المؤقت", createTimer);
  await renderDurationSection(countdownsBox, "countdown", "العدّ التنازلي", createCountdown);
  await renderReminders(remindersBox);

  // تحديث العرض فقط كل ثانية: المتبقي يُعاد اشتقاقه من target_at (لا عدّاد مستقل بذاته).
  setInterval(() => {
    renderDurationSection(timersBox, "timer", "المؤقت", createTimer);
    renderDurationSection(countdownsBox, "countdown", "العدّ التنازلي", createCountdown);
  }, REFRESH_MS);

  startVoiceReminderLoop();
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
  if (document.readyState !== "loading") boot();
}

export { renderAlarms, renderDurationSection, renderReminders };
