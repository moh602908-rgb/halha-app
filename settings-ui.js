/* ============================================================
   settings-ui.js — صفحة الإعدادات الشخصية (الخطة Free/Premium، الاسم، الصوت الذكي، Premium يدوي)
   ============================================================
   لا استيراد لـ app.js/ask.js/prompt.js/api/. تُقرأ/تُكتب عبر
   organizer-settings.js فقط (قاعدة dallini-organizer-time المنفصلة).
   الرأس والتنقل وزر الرجوع والعنوان من app-header.js. هذه الصفحة للإعدادات فقط: لا منبّهات ولا مؤقتات ولا
   حالة الإشعارات هنا (مكانها «منظومة الوقت»).
   ============================================================ */

import { getSettings, updateSettings } from "./organizer-settings.js";

/** ما يشمله كل مستوى — مصدر نصي واحد للعرض (الفصل الفعلي في الكود: buildVoiceText() هو نقطة تحكم Premium للصوت). */
export const PLAN_FEATURES = Object.freeze({
  free: Object.freeze([
    "المنبّه الأساسي",
    "التذكير الأساسي",
    "الإشعار النصي (بلا اسمك)",
    "الغفوة الأساسية (Snooze)",
    "المؤقت والعدّ التنازلي والتنظيم الأساسي",
  ]),
  premium: Object.freeze([
    "الصوت الذكي (نطق التذكير بصوت عالٍ)",
    "المناداة باسمك",
    "تنويع الصياغة",
    "مراعاة المجال والأولوية ووقت اليوم",
  ]),
});

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

function featureList(items) {
  return el("ul", { class: "plan-list" }, ...items.map((t) => el("li", {}, t)));
}

function renderPlanCard(premium) {
  return el("div", { class: "card", id: "plan-card", "data-plan": premium ? "premium" : "free" },
    el("div", { class: "row" },
      el("strong", {}, "خطتك الحالية"),
      el("span", { class: "plan-badge", "data-role": "plan-badge" }, premium ? "Premium (تفعيل يدوي مؤقت)" : "Free")),
    el("div", { class: "plan-col", "data-plan-col": "free" }, el("div", { class: "plan-col__title" }, "Free — متاح دائمًا"), featureList(PLAN_FEATURES.free)),
    el("div", { class: "plan-col", "data-plan-col": "premium" }, el("div", { class: "plan-col__title" }, "Premium"), featureList(PLAN_FEATURES.premium))
  );
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
    id: "settings-save",
    onclick: async () => {
      toast.textContent = ""; toast.classList.remove("toast--error");
      try {
        await updateSettings({
          display_name: nameInput.value.trim() || null,
          voice_reminders_enabled: voiceInput.checked,
          premium_active: premiumInput.checked,
        });
        await renderApp();
        const t2 = document.querySelector("#settings-root .toast"); if (t2) t2.textContent = "تم الحفظ.";
      } catch (e) {
        toast.classList.add("toast--error");
        toast.textContent = "تعذّر الحفظ: " + e.message;
      }
    },
  }, "حفظ");

  root.appendChild(renderPlanCard(!!settings.premium_active));

  root.appendChild(el("div", { class: "card" },
    el("label", { class: "field-label" }, "الاسم الذي يناديك به الصوت الذكي (Premium)"),
    nameInput,
    el("div", { class: "hint" }, "يُستخدم في الصوت الذكي فقط، ولا يظهر اسمك في الإشعار الأساسي أبدًا.")
  ));

  root.appendChild(el("div", { class: "card" },
    el("div", { class: "row" }, el("span", {}, "تفعيل الصوت الذكي (Premium)"), voiceInput),
    el("div", { class: "hint" }, "يعمل الصوت فقط والصفحة مفتوحة على المتصفح؛ لا صوت ولا إشعار على الويب بعد إغلاق الصفحة. لن يُنطق التذكير إلا مع تفعيل Premium.")
  ));

  root.appendChild(el("div", { class: "card" },
    el("div", { class: "row" }, el("span", {}, "ميزة Premium (تفعيل يدوي مؤقت — لا يوجد نظام اشتراك بعد)"), premiumInput),
    el("div", { class: "hint" }, "المنبّه والتذكير والإشعار النصي والغفوة والمؤقت والعدّ التنازلي والتنظيم الأساسي متاحة دائمًا بلا قيد.")
  ));

  root.appendChild(saveBtn);
  root.appendChild(toast);
}

let booted = false;
function boot() { if (booted) return; booted = true; renderApp(); }
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
  if (document.readyState !== "loading") boot();
}

export { renderApp }; // للاختبار المباشر بلا انتظار DOMContentLoaded
