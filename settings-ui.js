/* ============================================================
   settings-ui.js — صفحة الإعدادات الشخصية (الاسم، الصوت، Premium يدوي)
   ============================================================
   لا استيراد لـ app.js/ask.js/prompt.js/api/. تُقرأ/تُكتب عبر
   organizer-settings.js فقط (قاعدة dallini-organizer-time المنفصلة).
   ============================================================ */

import { getSettings, updateSettings } from "./organizer-settings.js";

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

async function renderApp() {
  const root = document.getElementById("settings-root");
  if (!root) return;
  root.innerHTML = "";
  const settings = await getSettings();
  const toast = el("div", { class: "toast" });

  const nameInput = el("input", { class: "input", type: "text", maxlength: "60", placeholder: "مثال: محمد" });
  nameInput.value = settings.display_name || "";

  const voiceInput = el("input", { type: "checkbox" });
  voiceInput.checked = !!settings.voice_reminders_enabled;

  const premiumInput = el("input", { type: "checkbox" });
  premiumInput.checked = !!settings.premium_active;

  const saveBtn = el("button", {
    class: "btn",
    onclick: async () => {
      toast.textContent = ""; toast.classList.remove("toast--error");
      try {
        await updateSettings({
          display_name: nameInput.value.trim() || null,
          voice_reminders_enabled: voiceInput.checked,
          premium_active: premiumInput.checked,
        });
        toast.textContent = "تم الحفظ.";
      } catch (e) {
        toast.classList.add("toast--error");
        toast.textContent = "تعذّر الحفظ: " + e.message;
      }
    },
  }, "حفظ");

  root.appendChild(el("a", { class: "back-link", href: "today.html" }, "‹ العودة إلى اليوم"));
  root.appendChild(el("h1", { class: "page-title" }, "الإعدادات"));

  root.appendChild(el("div", { class: "card" },
    el("label", { class: "field-label" }, "الاسم الذي تريد أن يناديك به المرافق"),
    nameInput
  ));

  root.appendChild(el("div", { class: "card" },
    el("div", { class: "row" }, el("span", {}, "تفعيل التذكيرات الصوتية"), voiceInput),
    el("div", { class: "hint" }, "يعمل الصوت فقط والصفحة مفتوحة على المتصفح. عند إغلاق التطبيق يبقى إشعار نصي.")
  ));

  root.appendChild(el("div", { class: "card" },
    el("div", { class: "row" }, el("span", {}, "ميزة Premium (تفعيل يدوي مؤقت — لا يوجد نظام اشتراك بعد)"), premiumInput),
    el("div", { class: "hint" }, "التذكير الصوتي والمناداة بالاسم من ميزات Premium فقط. المنبّه والمؤقت والعدّ التنازلي والتنظيم الأساسي متاحون دائمًا بلا قيد.")
  ));

  root.appendChild(saveBtn);
  root.appendChild(toast);
}

function boot() { renderApp(); }
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
  if (document.readyState !== "loading") boot();
}

export { renderApp }; // للاختبار المباشر بلا انتظار DOMContentLoaded
