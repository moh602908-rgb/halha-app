/* ============================================================
   today-ui.js — Organizer Core: شاشة «اليوم» (Today UI)
   ============================================================
   طبقة واجهة، مستقلة تمامًا عن app.js/index.html/ask.js — لا علاقة
   لها بمسار AI، ولا شبكة، ولا Gemini.

   الاستيراد: listAllOccurrences من organizer-selection.js،
   classifyTodayGroup وorderTodayOccurrences من organizer-today.js،
   getEffectiveSchedule وquickPostpone وpostponeOccurrence من
   organizer-postpone.js، updateOccurrence وgetOccurrence من
   organizer-crud.js، deleteOccurrence من organizer-editing.js،
   generateNextOccurrenceForSeries من organizer-recurrence.js،
   stopSeries من organizer-series-stop.js (جديد)، buildAddModal من
   today-add.js (جديد). لا تعديل على أي من الملفات السبعة المعتمدة.

   منطق "اختيار عناصر اليوم" (Selection) — قرار مُشتق حرفيًا من
   Functional Specification V1.0 البند 14: الفائت يبقى ظاهرًا من أي
   يوم سابق بلا حد أقصى؛ غير الفائت (قادم/مكتمل) يظهر فقط إن كان
   تاريخه الفعّال هو اليوم الحالي. هذا المنطق هنا فقط، وليس داخل
   organizer-today.js (الذي يبقى ترتيبًا نقيًا بلا اختيار، كما هو).

   "لحاق" السلاسل المتكررة بلحظة العرض — إصلاح حقيقي مكتشف في هذه
   الحزمة: generateNextOccurrenceForSeries (المعتمدة، بلا تعديل)
   تولّد خطوة واحدة فقط من آخر حدوث موجود فعليًا، ولا "تلحق" باليوم
   الحالي تلقائيًا. بدون هذا، سلسلة لم تُفتح شاشة اليوم لعدة أيام
   تَغيب حدوثاتها عن اليوم. الحل: استدعاء الدالة نفسها في حلقة قبل كل
   عرض (catchUpRecurringSeries)، بلا أي تعديل على organizer-recurrence.js.

   نطاق الإجراءات: إكمال/لم يكتمل/تراجع (فئة أ — البند 7-أ، لا تُشغِّل
   أي سؤال)، تأجيل سريع/مخصص (فئة أ أيضًا — البند 13)، وحذف (فئة ب إن
   كان العنصر ضمن سلسلة متكررة — البند 7-ب: يُشغِّل سؤال "هذه المرة
   فقط/كل مرة"؛ فئة أ إن كان عنصرًا مستقلًا — تأكيد بسيط فقط، البند 2).
   ============================================================ */

import { listAllOccurrences } from "./organizer-selection.js";
import { classifyTodayGroup, orderTodayOccurrences } from "./organizer-today.js";
import { getEffectiveSchedule, quickPostpone, postponeOccurrence } from "./organizer-postpone.js";
import { updateOccurrence, getOccurrence } from "./organizer-crud.js";
import { deleteOccurrence as softDeleteOccurrence } from "./organizer-editing.js";
import { generateNextOccurrenceForSeries } from "./organizer-recurrence.js";
import { stopSeries } from "./organizer-series-stop.js";
import { buildAddModal } from "./today-add.js";
import { getEffectiveEnd } from "./organizer-schedule.js";
import { DOMAIN_LABELS_AR, PRIORITY_LABELS_AR } from "./organizer-model.js";

const REFRESH_INTERVAL_MS = 60 * 1000; // إعادة رسم دورية محلية فقط (بلا شبكة) لإظهار الانتقال قادم→فائت تلقائيًا
const p2 = (n) => String(n).padStart(2, "0");
const localDateStr = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

const ICONS = {
  task: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h16M4 17h10" stroke-linecap="round"/></svg>',
  reminder: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a5 5 0 0 0-5 5v3.2c0 .7-.3 1.4-.8 1.9L5 14.5c-.6.6-.2 1.5.6 1.5h13c.8 0 1.2-.9.6-1.5l-1.2-1.4a2.7 2.7 0 0 1-.8-1.9V8a5 5 0 0 0-5-5z" stroke-linejoin="round"/><path d="M10 19a2 2 0 0 0 4 0" stroke-linecap="round"/></svg>',
  appointment: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M8 3.5v3.5M16 3.5v3.5M4 10h16" stroke-linecap="round"/></svg>',
  default: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.2"/></svg>',
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function arabicDayTitle(now) {
  try {
    return now.toLocaleDateString("ar", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  } catch (_) {
    return localDateStr(now);
  }
}

const MAX_CATCHUP_STEPS_PER_SERIES = 10000; // حارس أمان بحت — لا يُفعَّل في أي استخدام واقعي

// "لحاق" كل سلسلة متكررة نشطة حتى تاريخ اليوم، قبل أي عرض — راجع التعليق أعلى الملف.
async function catchUpRecurringSeries(all, todayStr) {
  const roots = all.filter((o) => o.occ_key === o.root_id && o.recurrence);
  let changed = false;
  for (const root of roots) {
    let latest = all
      .filter((o) => o.root_id === root.root_id)
      .reduce((max, o) => (o.date > max ? o.date : max), root.date);
    let steps = 0;
    while (latest < todayStr && steps < MAX_CATCHUP_STEPS_PER_SERIES) {
      const next = await generateNextOccurrenceForSeries(root.root_id);
      if (!next) break; // series_end بلغته — توقف طبيعي، ليس خطأ
      latest = next.date;
      changed = true;
      steps++;
    }
  }
  return changed;
}

// ---------- منطق اختيار عناصر اليوم (Selection) — البند 14 ----------
async function loadTodayView(now = new Date()) {
  let all = await listAllOccurrences();
  const todayStr = localDateStr(now);
  if (await catchUpRecurringSeries(all, todayStr)) {
    all = await listAllOccurrences(); // إعادة قراءة بعد توليد حدوثات جديدة أثناء اللحاق
  }
  const relevant = all.filter((occ) => {
    const group = classifyTodayGroup(occ, now);
    if (group === "excluded") return false;
    if (group === "missed") return true; // من أي يوم سابق، بلا حد أقصى — البند 14
    const eff = getEffectiveSchedule(occ);
    return eff.date === todayStr; // قادم/مكتمل: فقط إن كان تاريخها الفعّال اليوم
  });
  return orderTodayOccurrences(relevant, now);
}

// ---------- الإجراءات (كلها تُعيد الرسم بعد النجاح، وتُظهر رسالة عند الفشل) ----------
function withBusyGuard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
      await renderApp();
    } catch (err) {
      showToast(err && err.message ? err.message : "تعذّر تنفيذ الإجراء");
      await renderApp();
    }
  };
}

const actions = {
  complete: withBusyGuard((occ_key) => updateOccurrence(occ_key, { status: "completed" })),
  notCompleted: withBusyGuard((occ_key) => updateOccurrence(occ_key, { status: "not_completed" })),
  undo: withBusyGuard((occ_key) => updateOccurrence(occ_key, { status: "upcoming" })),
  postponeHour: withBusyGuard((occ_key) => quickPostpone(occ_key, { amount: 1, unit: "hours" })),
  postponeTomorrow: withBusyGuard((occ_key) => quickPostpone(occ_key, { amount: 1, unit: "days" })),
  postponeCustom: withBusyGuard((occ_key, date, time) => postponeOccurrence(occ_key, { date, time })),
  deleteSingle: withBusyGuard((occ_key) => softDeleteOccurrence(occ_key)),
  stopWholeSeries: withBusyGuard((root_id) => stopSeries(root_id)),
};

let toastTimer = null;
function showToast(msg) {
  const host = document.getElementById("today-toast");
  if (!host) return;
  host.textContent = msg;
  host.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove("visible"), 3500);
}

// ---------- عرض عنصر واحد ----------
function renderItem(occ, groupName) {
  const eff = getEffectiveSchedule(occ);
  const icon = ICONS[occ.itemType] || ICONS.default;
  const card = el("li", { class: `item item--${groupName}` });

  card.appendChild(el("span", { class: "item__icon", html: icon }));

  const body = el("div", { class: "item__body" });
  body.appendChild(el("div", { class: "item__title" }, occ.title || ""));
  if (eff.time) {
    // النهاية مشتقة من البداية الفعلية + مدة الموعد (لا تبقى نهاية قديمة بعد تأجيل/تحرير).
    const end = getEffectiveEnd(occ);
    let timeLabel = eff.time;
    if (end) {
      timeLabel = `${eff.time} – ${end.time}`;
      if (end.date !== eff.date) timeLabel += " (اليوم التالي)";
    }
    body.appendChild(el("div", { class: "item__time" }, timeLabel));
  }
  // Foundation v2: المجال والأولوية والملاحظة (نصوص فقط عبر createTextNode، لا innerHTML).
  const chips = [];
  if (occ.domain) chips.push(el("span", { class: "item__chip" }, DOMAIN_LABELS_AR[occ.domain] || occ.domain));
  if (occ.priority === "high" || occ.priority === "low") {
    chips.push(el("span", { class: `item__chip item__chip--${occ.priority}` }, `أولوية ${PRIORITY_LABELS_AR[occ.priority]}`));
  }
  if (chips.length) body.appendChild(el("div", { class: "item__meta" }, ...chips));
  if (occ.note) body.appendChild(el("div", { class: "item__note" }, occ.note));
  card.appendChild(body);

  const actionsRow = el("div", { class: "item__actions" });

  if (groupName === "completed") {
    actionsRow.appendChild(
      el("button", { class: "btn btn--ghost", onclick: () => actions.undo(occ.occ_key) }, "↺ تراجع")
    );
  } else {
    actionsRow.appendChild(
      el("button", { class: "btn btn--complete", onclick: () => actions.complete(occ.occ_key) }, "✓ إكمال")
    );
    actionsRow.appendChild(
      el("button", { class: "btn btn--ghost", onclick: () => actions.notCompleted(occ.occ_key) }, "✗ لم يكتمل")
    );
    actionsRow.appendChild(
      el("button", { class: "btn btn--ghost", onclick: () => actions.postponeHour(occ.occ_key) }, "بعد ساعة")
    );
    actionsRow.appendChild(
      el("button", { class: "btn btn--ghost", onclick: () => actions.postponeTomorrow(occ.occ_key) }, "غدًا")
    );
    actionsRow.appendChild(renderCustomPostponeToggle(occ, eff));
  }
  actionsRow.appendChild(renderDeleteControl(occ));
  card.appendChild(actionsRow);
  return card;
}

// حذف — البند 2 (عنصر مستقل: تأكيد بسيط) والبند 7-ب (عنصر ضمن سلسلة
// متكررة: سؤال "هذه المرة فقط/كل مرة"). الفحص عبر جلب سجل الجذر
// الفعلي (occ.root_id) والتأكد إن كان يحمل recurrence.
function renderDeleteControl(occ) {
  const wrap = el("div", { class: "delete-control" });
  const toggleBtn = el("button", { class: "btn btn--danger" }, "🗑 حذف");
  const panel = el("div", { class: "delete-control__panel hidden" });

  toggleBtn.addEventListener("click", async () => {
    if (!panel.classList.contains("hidden")) {
      panel.classList.add("hidden");
      return;
    }
    panel.innerHTML = "";
    panel.appendChild(el("span", { class: "delete-control__q" }, "..."));
    panel.classList.remove("hidden");

    let root = null;
    try {
      root = await getOccurrence(occ.root_id);
    } catch (_) { /* يُعامَل كعنصر مستقل عند الفشل */ }

    panel.innerHTML = "";
    if (root && root.recurrence) {
      panel.appendChild(el("span", { class: "delete-control__q" }, "حذف هذه المرة فقط أم كل مرة؟"));
      panel.appendChild(
        el("button", { class: "btn btn--danger", onclick: () => actions.deleteSingle(occ.occ_key) }, "هذه المرة فقط")
      );
      panel.appendChild(
        el("button", { class: "btn btn--danger", onclick: () => actions.stopWholeSeries(occ.root_id) }, "كل مرة (إيقاف السلسلة)")
      );
    } else {
      panel.appendChild(el("span", { class: "delete-control__q" }, "تأكيد الحذف؟"));
      panel.appendChild(
        el("button", { class: "btn btn--danger", onclick: () => actions.deleteSingle(occ.occ_key) }, "تأكيد")
      );
    }
    panel.appendChild(el("button", { class: "btn btn--ghost", onclick: () => panel.classList.add("hidden") }, "إلغاء"));
  });

  wrap.appendChild(toggleBtn);
  wrap.appendChild(panel);
  return wrap;
}

function renderCustomPostponeToggle(occ, eff) {
  const wrap = el("div", { class: "custom-postpone" });
  const toggleBtn = el("button", { class: "btn btn--ghost" }, "تأجيل مخصص");
  const form = el("div", { class: "custom-postpone__form hidden" });
  const dateInput = el("input", { type: "date", class: "input", value: eff.date || "" });
  const timeInput = el("input", { type: "time", class: "input", value: eff.time || "" });
  const confirmBtn = el("button", { class: "btn btn--complete" }, "تأكيد");
  const cancelBtn = el("button", { class: "btn btn--ghost" }, "إلغاء");

  toggleBtn.addEventListener("click", () => form.classList.toggle("hidden"));
  cancelBtn.addEventListener("click", () => form.classList.add("hidden"));
  confirmBtn.addEventListener("click", () =>
    actions.postponeCustom(occ.occ_key, dateInput.value, timeInput.value)
  );

  form.appendChild(dateInput);
  form.appendChild(timeInput);
  form.appendChild(confirmBtn);
  form.appendChild(cancelBtn);
  wrap.appendChild(toggleBtn);
  wrap.appendChild(form);
  return wrap;
}

// ---------- عرض قسم ----------
function renderSection(title, items, groupName, opts = {}) {
  if (items.length === 0) return null;
  const section = el("section", { class: `section section--${groupName}` });
  section.appendChild(el("h2", { class: "section__title" }, title));
  const list = el("ul", { class: "item-list" });
  for (const occ of items) list.appendChild(renderItem(occ, groupName));
  section.appendChild(list);

  if (opts.collapsible) {
    section.classList.add("collapsed");
    section.querySelector(".section__title").addEventListener("click", () => {
      section.classList.toggle("collapsed");
    });
  }
  return section;
}

// UX Core C: داخل "قادم"، الموقَّت أولًا ثم المهام بلا وقت في "مجموعة منفصلة أسفلها".
// organizer-today.js يرتّبها بهذا الترتيب فعليًا؛ هذا فقط يضيف فاصلًا بصريًا بينهما دون تغيير الترتيب.
function renderUpcomingSection(items) {
  if (items.length === 0) return null;
  const section = el("section", { class: "section section--upcoming" });
  section.appendChild(el("h2", { class: "section__title" }, "قادم"));
  const list = el("ul", { class: "item-list" });
  let untimedStarted = false;
  for (const occ of items) {
    const eff = getEffectiveSchedule(occ);
    if (!eff.time && !untimedStarted) {
      untimedStarted = true;
      list.appendChild(el("li", { class: "item-list__divider" }, "بلا وقت محدد"));
    }
    list.appendChild(renderItem(occ, "upcoming"));
  }
  section.appendChild(list);
  return section;
}

function renderEmptyState() {
  const wrap = el("div", { class: "empty-state" });
  wrap.appendChild(el("p", { class: "empty-state__msg" }, "لا شيء مجدول اليوم"));
  wrap.appendChild(renderAddButton());
  return wrap;
}

function renderAddButton() {
  return el(
    "button",
    { class: "btn btn--fab", onclick: () => openAddModal() },
    "+ إضافة"
  );
}

function openAddModal() {
  const existing = document.getElementById("today-add-modal");
  if (existing) return; // مفتوح بالفعل — لا نكرّر
  const modal = buildAddModal({
    onCreated: () => { modal.remove(); renderApp(); },
    onCancel: () => modal.remove(),
  });
  modal.id = "today-add-modal";
  document.body.appendChild(modal);
}

// ---------- الرسم الكامل ----------
async function renderApp() {
  const root = document.getElementById("today-root");
  if (!root) return;
  const now = new Date();
  const view = await loadTodayView(now);

  root.innerHTML = "";
  const nav = el("div", { class: "nav-links" },
    el("a", { href: "time.html" }, "منظومة الوقت"),
    el("a", { href: "settings.html" }, "الإعدادات")
  );
  root.appendChild(nav);
  const header = el("header", { class: "today-header" });
  header.appendChild(el("h1", { class: "today-header__date" }, arabicDayTitle(now)));
  header.appendChild(renderAddButton());
  root.appendChild(header);

  if (view.ordered.length === 0) {
    root.appendChild(renderEmptyState());
    return;
  }

  const missedSection = renderSection("فائت", view.missed, "missed");
  const upcomingSection = renderUpcomingSection(view.upcoming);
  const completedSection = renderSection("أُنجز اليوم", view.completed, "completed", { collapsible: true });

  if (missedSection) root.appendChild(missedSection);
  if (upcomingSection) root.appendChild(upcomingSection);
  if (completedSection) root.appendChild(completedSection);
}

function boot() {
  renderApp();
  setInterval(renderApp, REFRESH_INTERVAL_MS);
  // حلقة التذكير الصوتي: تعمل فقط والصفحة مفتوحة (قيد speechSynthesis في المتصفح). استيراد ديناميكي
  // حتى لا تنكسر Today لو تعذّر تحميل ملفات Time System لأي سبب (عزل الفشل، لا اعتمادية صلبة).
  import("./voice-tts-web.js").then((m) => m.startVoiceReminderLoop()).catch(() => {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
