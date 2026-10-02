/* ============================================================
   time-ui.js — صفحة منظومة الوقت (منبّه/مؤقت/عدّ تنازلي/تذكيرات + حالة الإشعارات)
   ============================================================
   لا استيراد لـ app.js/ask.js/prompt.js/api/. العرض يُعاد اشتقاقه دوريًا
   من target_at/fire_at (setInterval هنا للعرض فقط، ليس مصدر الحقيقة —
   انظر organizer-time.js). يبدأ أيضًا حلقة الإطلاق (voice-tts-web.js)
   لأنها تعمل فقط والصفحة مفتوحة. الرأس والتنقل وزر الرجوع والعنوان من app-header.js (لا نسخ محلية).
   هذه الصفحة لمنظومة الوقت فقط: لا إعدادات اسم/Premium هنا (مكانها صفحة الإعدادات).
   ============================================================ */

import {
  listEntities, deleteEntity,
  createAlarm, setAlarmEnabled, nextAlarmFireAt, oneShotDueAt, clearSnooze,
  createTimer, createCountdown, pauseTimer, resumeTimer, cancelTimer, remainingMs,
} from "./organizer-time.js";
import {
  startVoiceReminderLoop, getNotificationPermissionState, requestNotificationPermission,
  watchNotificationPermission, FIRED_EVENT_NAME,
} from "./voice-tts-web.js";

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_LABELS = { SU: "أحد", MO: "اثنين", TU: "ثلاثاء", WE: "أربعاء", TH: "خميس", FR: "جمعة", SA: "سبت" };
const REFRESH_MS = 1000;
const TIME_CHANGED_EVENT = "dallini:time-changed";

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
const fmtClock = (ms) => new Date(ms).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });

/* ---------- حالة الإشعارات (Free) + حدود الويب ---------- */

const PERMISSION_COPY = Object.freeze({
  granted: { badge: "مفعّلة", text: "الإشعارات مفعّلة: ستصلك تنبيهات المنبّه والتذكير والمؤقت ما دامت صفحة دلّني مفتوحة." },
  default: { badge: "لم تُفعَّل بعد", text: "فعّل الإشعارات ليصلك تنبيه نصي عند حلول الموعد." },
  denied: { badge: "محظورة", text: "الإشعارات محظورة لهذا الموقع. فعّلها من إعدادات المتصفح ثم أعد تحميل الصفحة." },
  unsupported: { badge: "غير مدعومة", text: "هذا المتصفح لا يدعم الإشعارات هنا. على آيفون أضف التطبيق إلى الشاشة الرئيسية أولًا." },
});
const WEB_LIMITS_NOTE = "حدود الويب: لا يصلك تنبيه ولا صوت بعد إغلاق الصفحة، وقد يتأخر أو يتوقف إن جمّد المتصفح الصفحة في الخلفية. تنبيه موثوق بعد إغلاق التطبيق يحتاج تطبيقًا أصليًا (أندرويد) وهو غير متاح بعد. عند عودتك للصفحة يُفحص ما استحق فورًا.";

function renderNotificationCard(card, state) {
  const copy = PERMISSION_COPY[state] || PERMISSION_COPY.unsupported;
  card.setAttribute("data-permission-state", state);
  card.innerHTML = "";
  card.appendChild(el("h2", { class: "section-title" }, "حالة الإشعارات"));
  card.appendChild(el("div", { class: "row item-row" },
    el("div", {}, el("strong", { "data-role": "perm-badge" }, copy.badge), el("div", { class: "hint", "data-role": "perm-text" }, copy.text)),
    state === "default"
      ? el("button", { class: "btn", id: "notif-enable-btn", type: "button", onclick: async () => { renderNotificationCard(card, await requestNotificationPermission()); } }, "تفعيل الإشعارات")
      : null
  ));
  card.appendChild(el("div", { class: "hint", "data-role": "web-limits" }, WEB_LIMITS_NOTE));
}

/* ---------- المنبّه ---------- */

function alarmHint(a) {
  const parts = [a.time];
  if (a.days && a.days.length) parts.push(a.days.length === 7 ? "يوميًا" : a.days.map((d) => DAY_LABELS[d]).join("، "));
  const next = nextAlarmFireAt(a);
  if (next) parts.push("القادم: " + next.toLocaleString("ar"));
  else if (!(a.days && a.days.length)) parts.push(a.status === "fired" ? "انتهى (رنّ)" : (oneShotDueAt(a) !== null ? "فات موعده" : ""));
  if (typeof a.snoozed_until === "number" && a.snoozed_until > Date.now()) parts.push("غفوة حتى " + fmtClock(a.snoozed_until));
  return parts.filter(Boolean).join(" · ");
}

async function renderAlarms(container) {
  container.innerHTML = "";
  container.appendChild(el("h2", { class: "section-title" }, "المنبّه"));
  const alarms = await listEntities("alarm");
  for (const a of alarms) {
    const snoozed = typeof a.snoozed_until === "number" && a.snoozed_until > Date.now();
    const row = el("div", { class: "row item-row", "data-id": a.id },
      el("div", {}, el("strong", {}, a.title), el("div", { class: "hint" }, alarmHint(a))),
      el("div", { class: "actions" },
        snoozed ? el("button", { class: "btn btn--ghost", "data-action": "clear-snooze", onclick: () => clearSnooze(a.id).then(() => renderAlarms(container)) }, "إلغاء الغفوة") : null,
        el("input", { type: "checkbox", "aria-label": "تشغيل المنبّه", ...(a.enabled ? { checked: "checked" } : {}), onchange: (ev) => setAlarmEnabled(a.id, ev.target.checked).then(() => renderAlarms(container)) }),
        el("button", { class: "btn btn--ghost", onclick: () => deleteEntity(a.id).then(() => renderAlarms(container)) }, "حذف"))
    );
    container.appendChild(row);
  }
  const titleInput = el("input", { class: "input", type: "text", placeholder: "عنوان المنبّه" });
  const timeInput = el("input", { class: "input", type: "time" });
  const dailyInput = el("input", { type: "checkbox", id: "alarm-daily" });
  container.appendChild(el("div", { class: "form-row" }, titleInput, timeInput,
    el("button", { class: "btn", onclick: async () => {
      if (!titleInput.value.trim() || !timeInput.value) return;
      await createAlarm({ title: titleInput.value, time: timeInput.value, days: dailyInput.checked ? [...DAYS] : null });
      titleInput.value = ""; timeInput.value = ""; dailyInput.checked = false;
      renderAlarms(container);
    } }, "+ إضافة منبّه")
  ));
  container.appendChild(el("label", { class: "hint check-line" }, dailyInput, " يتكرر يوميًا (وإلا يرنّ مرة واحدة)"));
}

/* ---------- المؤقت والعدّ التنازلي ---------- */

async function renderDurationSection(container, kind, title, createFn) {
  container.innerHTML = "";
  container.appendChild(el("h2", { class: "section-title" }, title));
  const items = await listEntities(kind);
  const now = Date.now();
  for (const r of items) {
    if (r.status === "cancelled") continue;
    const remaining = remainingMs(r, now);
    const row = el("div", { class: "row item-row", "data-id": r.id, "data-status": r.status },
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

/** تحديث نصوص المتبقي فقط (بلا إعادة بناء النموذج، فلا يضيع ما يكتبه المستخدم)؛ إعادة بناء كاملة عند تغيّر الحالة. */
async function refreshDurationValues(container, kind, title, createFn) {
  const items = await listEntities(kind);
  const now = Date.now();
  const rows = [...container.querySelectorAll("[data-id]")];
  const visible = items.filter((r) => r.status !== "cancelled");
  const changed = rows.length !== visible.length || visible.some((r) => {
    const row = container.querySelector(`[data-id="${CSS.escape(r.id)}"]`);
    return !row || row.getAttribute("data-status") !== r.status;
  });
  if (changed) {
    const focused = document.activeElement && container.contains(document.activeElement);
    if (!focused) await renderDurationSection(container, kind, title, createFn);
    return;
  }
  for (const r of visible) {
    const row = container.querySelector(`[data-id="${CSS.escape(r.id)}"] .timer-remaining`);
    if (row) row.textContent = r.status === "fired" ? "انتهى" : fmtRemaining(remainingMs(r, now));
  }
}

/* ---------- التذكيرات ---------- */

async function renderReminders(container) {
  container.innerHTML = "";
  container.appendChild(el("h2", { class: "section-title" }, "التذكيرات"));
  const items = await listEntities("reminder");
  for (const r of items) {
    const snoozed = typeof r.snoozed_until === "number" && r.snoozed_until > Date.now();
    container.appendChild(el("div", { class: "row item-row", "data-id": r.id },
      el("div", {}, el("strong", {}, r.title), el("div", { class: "hint" }, `مرتبط بموعد: ${r.occ_key} · قبله بـ ${r.fire_offset_min} دقيقة` + (snoozed ? " · غفوة حتى " + fmtClock(r.snoozed_until) : ""))),
      el("div", { class: "actions" },
        snoozed ? el("button", { class: "btn btn--ghost", "data-action": "clear-snooze", onclick: () => clearSnooze(r.id).then(() => renderReminders(container)) }, "إلغاء الغفوة") : null,
        el("button", { class: "btn btn--ghost", onclick: () => deleteEntity(r.id).then(() => renderReminders(container)) }, "حذف"))
    ));
  }
  container.appendChild(el("div", { class: "hint" }, "تُضاف التذكيرات المرتبطة بموعد تلقائيًا من صفحة اليوم عند تحديد وقت التذكير."));
}

let booted = false;
async function boot() {
  const root = document.getElementById("time-root");
  if (!root || booted) return; // حارس: وحدات ES تعمل والصفحة interactive فيُستدعى boot مرتين (مباشرة + DOMContentLoaded) فتتكرر البطاقات
  booted = true;

  const notifBox = el("section", { class: "card", id: "notif-card" }); root.appendChild(notifBox);
  const alarmsBox = el("section", { class: "card", id: "alarms-card" }); root.appendChild(alarmsBox);
  const timersBox = el("section", { class: "card", id: "timers-card" }); root.appendChild(timersBox);
  const countdownsBox = el("section", { class: "card", id: "countdowns-card" }); root.appendChild(countdownsBox);
  const remindersBox = el("section", { class: "card", id: "reminders-card" }); root.appendChild(remindersBox);

  watchNotificationPermission((state) => renderNotificationCard(notifBox, state));

  await renderAlarms(alarmsBox);
  await renderDurationSection(timersBox, "timer", "المؤقت", createTimer);
  await renderDurationSection(countdownsBox, "countdown", "العدّ التنازلي", createCountdown);
  await renderReminders(remindersBox);

  // تحديث العرض فقط كل ثانية: المتبقي يُعاد اشتقاقه من target_at (لا عدّاد مستقل بذاته).
  setInterval(() => {
    refreshDurationValues(timersBox, "timer", "المؤقت", createTimer);
    refreshDurationValues(countdownsBox, "countdown", "العدّ التنازلي", createCountdown);
  }, REFRESH_MS);

  // بعد أي إطلاق أو Snooze: أعد اشتقاق القوائم (لا حالة محلية مكررة).
  const refreshLists = () => { renderAlarms(alarmsBox); renderReminders(remindersBox); };
  window.addEventListener(FIRED_EVENT_NAME, refreshLists);
  window.addEventListener(TIME_CHANGED_EVENT, refreshLists);

  startVoiceReminderLoop();
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
  if (document.readyState !== "loading") boot();
}

export { renderAlarms, renderDurationSection, renderReminders, renderNotificationCard, getNotificationPermissionState };
