/* ============================================================
   settings-ui.js — صفحة الإعدادات الشخصية (الخطة Free/Premium، الاسم، الصوت الذكي، Premium يدوي)
   ============================================================
   لا استيراد لـ app.js/ask.js/prompt.js/api/. تُقرأ/تُكتب عبر
   organizer-settings.js فقط (قاعدة dallini-organizer-time المنفصلة).
   الرأس والتنقل وزر الرجوع والعنوان من app-header.js. هذه الصفحة للإعدادات فقط: لا منبّهات ولا مؤقتات ولا
   حالة الإشعارات هنا (مكانها «منظومة الوقت»).
   ============================================================ */

import { getSettings, updateSettings } from "./organizer-settings.js";
import { testSpeech } from "./voice-tts-web.js";

/** ما يشمله كل مستوى — مصدر نصي واحد للعرض (الفصل الفعلي في الكود: buildVoiceText() هو نقطة تحكم Premium للصوت). */
export const PLAN_FEATURES = Object.freeze({
  free: Object.freeze([
    "المنبّه الأساسي مع نغمة رنين",
    "التذكير الأساسي",
    "الإشعار النصي (بلا اسمك)",
    "الغفوة الأساسية (Snooze)",
    "المؤقت والعدّ التنازلي والتنظيم الأساسي",
  ]),
  premium: Object.freeze([
    "الصوت الذكي (نطق التذكير والمنبّه بصوت عالٍ)",
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

/** نص النتيجة لكل حالة من testSpeech (عربي واضح؛ لا يُحفظ شيء). */
export const TTS_RESULT_COPY = Object.freeze({
  ok: { ok: true, text: "الصوت متاح: بدأ النطق وفيه صوت عربي على جهازك." },
  ok_no_arabic: { ok: true, text: "النطق يعمل، لكن لا يوجد صوت عربي مثبّت على جهازك؛ قد تُنطق الجملة بصوت آخر. ثبّت صوتًا عربيًا من إعدادات تحويل النص إلى كلام في الهاتف." },
  unsupported: { ok: false, text: "الصوت غير متاح: هذا المتصفح لا يدعم النطق." },
  no_start: { ok: false, text: "الصوت غير متاح: لم يبدأ النطق. غالبًا لا يوجد محرك نطق على الجهاز." },
  error: { ok: false, text: "فشل النطق." },
});
const TTS_ERROR_HINTS = Object.freeze({ "not-allowed": " منعه المتصفح؛ المس الصفحة ثم أعد المحاولة.", "synthesis-unavailable": " لا يوجد محرك نطق متاح.", "language-unavailable": " اللغة العربية غير متاحة للنطق." });

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
    el("div", { class: "hint" }, "يعمل الصوت والنغمة فقط والصفحة مفتوحة على المتصفح؛ لا صوت ولا نغمة ولا إشعار على الويب بعد إغلاق الصفحة. لن يُنطق التذكير أو المنبّه إلا مع تفعيل Premium.")
  ));

  root.appendChild(el("div", { class: "card" },
    el("div", { class: "row" }, el("span", {}, "ميزة Premium (تفعيل يدوي مؤقت — لا يوجد نظام اشتراك بعد)"), premiumInput),
    el("div", { class: "hint" }, "المنبّه والتذكير والإشعار النصي والغفوة والمؤقت والعدّ التنازلي والتنظيم الأساسي متاحة دائمًا بلا قيد.")
  ));

  const ttsResult = el("div", { class: "hint", id: "tts-test-result", role: "status", "aria-live": "polite" });
  const ttsBtn = el("button", {
    class: "btn", id: "tts-test-btn", type: "button",
    onclick: async () => {
      ttsBtn.disabled = true; ttsResult.removeAttribute("data-status"); ttsResult.textContent = "جارٍ اختبار الصوت…";
      const r = await testSpeech(window);
      const copy = TTS_RESULT_COPY[r.status] || TTS_RESULT_COPY.error;
      ttsResult.setAttribute("data-status", r.status);
      ttsResult.textContent = (copy.ok ? "✔ " : "✖ ") + copy.text + (r.status === "error" ? (TTS_ERROR_HINTS[r.error] || (r.error ? ` (${r.error})` : "")) : "");
      ttsBtn.disabled = false;
    },
  }, "جرّب الصوت الآن");
  root.appendChild(el("div", { class: "card", id: "tts-test-card" },
    el("div", { class: "row" }, el("span", {}, "اختبار الصوت على جهازك (مجاني)"), ttsBtn),
    el("div", { class: "hint" }, "يختبر نطق المتصفح المحلي فقط: بلا إنترنت ولا حفظ بيانات."),
    ttsResult
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
