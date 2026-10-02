/* ============================================================
   app-header.js — المصدر الواحد للرأس والتنقل (اليوم / منظومة الوقت / الإعدادات)
   ============================================================
   كل صفحة تضع <div id="app-header" data-page="today|time|settings"></div> وتحمّل هذا الملف؛ لا تحمل أي صفحة
   رأسها أو روابط تنقّلها بنفسها. يوفّر: عنوانًا واحدًا واضحًا للصفحة، زر رجوع حقيقيًا (رابط فعلي)،
   تبويبات بحالة Active واضحة (aria-current)، وحاوية "صينية الرنين" (ring-tray.js) لعرض ما أُطلق الآن مع Snooze.
   الهوية: نفس تدرّج شريط التطبيق الرئيسي (style.css .topbar) وألوان #12377D/#6C4CE0 — بلا تصميم بصري منفصل.
   RTL: خصائص منطقية (inline) + اتجاه الصفحة؛ سهم الرجوع يشير لليمين (اتجاه الرجوع في RTL).
   لا شبكة، لا استيراد لـ app.js/ask.js/prompt.js/api/. الصينية تُحمَّل ديناميكيًا لعزل أي فشل عن التنقل.
   ============================================================ */

export const NAV_ITEMS = Object.freeze([
  Object.freeze({ id: "today", label: "اليوم", href: "today.html" }),
  Object.freeze({ id: "time", label: "منظومة الوقت", href: "time.html" }),
  Object.freeze({ id: "settings", label: "الإعدادات", href: "settings.html" }),
]);

/** وجهة زر الرجوع لكل صفحة: الفرعيتان (الوقت/الإعدادات) ← اليوم، واليوم ← التطبيق الرئيسي. */
export const BACK_TARGETS = Object.freeze({
  today: Object.freeze({ href: "index.html", label: "رجوع إلى الصفحة الرئيسية" }),
  time: Object.freeze({ href: "today.html", label: "رجوع إلى اليوم" }),
  settings: Object.freeze({ href: "today.html", label: "رجوع إلى اليوم" }),
});

const STYLE_ID = "app-header-style";
const CSS = `
.ah { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 40; max-width: 600px; margin: 0 auto 14px; padding: 8px 14px 0; box-sizing: border-box; direction: rtl; font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif; }
.ah * { box-sizing: border-box; }
.ah__card { background: linear-gradient(120deg, #0A1A4D 0%, #12377D 55%, #4A3AB8 100%); color: #fff; border-radius: 18px; box-shadow: 0 6px 20px rgba(23, 27, 38, 0.14); overflow: hidden; }
.ah__bar { display: flex; align-items: center; gap: 10px; padding: 10px 12px; min-height: 56px; }
.ah__back { display: inline-flex; align-items: center; gap: 4px; min-height: 40px; padding: 0 12px 0 14px; border-radius: 12px; background: rgba(255, 255, 255, 0.16); color: #fff; text-decoration: none; font-size: 14px; font-weight: 700; white-space: nowrap; }
.ah__back:focus-visible, .ah__tab:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.ah__title { flex: 1; min-width: 0; margin: 0; font-size: 18px; font-weight: 800; line-height: 1.3; }
.ah__brand { font-size: 15px; font-weight: 800; color: #fff; opacity: 0.92; white-space: nowrap; }
.ah__brand span { color: #C4B8FF; }
.ah__tabs { display: flex; gap: 4px; padding: 4px; background: rgba(0, 0, 0, 0.2); }
.ah__tab { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 40px; padding: 0 4px; border-radius: 12px; color: rgba(255, 255, 255, 0.85); text-decoration: none; font-size: 13.5px; font-weight: 700; text-align: center; }
.ah__tab.is-active { background: #fff; color: #12377D; }
.ah__tray { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.ah__tray:empty { display: none; }
`;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) { if (c != null) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); }
  return node;
}

function backIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "18"); svg.setAttribute("height", "18"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none"); svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M9 5l7 7-7 7"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "2.4");
  path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

/** يبني الرأس داخل container للصفحة page (today|time|settings). idempotent: استدعاء ثانٍ يعيد البناء بلا تكرار. */
export function mountAppHeader(container, { page }) {
  const current = NAV_ITEMS.find((n) => n.id === page);
  if (!container || !current) throw new Error(`app_header_invalid_page: ${page}`);
  if (!document.getElementById(STYLE_ID)) { const st = el("style", { id: STYLE_ID }); st.textContent = CSS; document.head.appendChild(st); }
  container.innerHTML = "";
  container.className = "ah";
  container.setAttribute("data-page", page);

  const back = BACK_TARGETS[page];
  const bar = el("div", { class: "ah__bar" },
    el("a", { class: "ah__back", href: back.href, "aria-label": back.label, "data-role": "back" }, backIcon(), "رجوع"),
    el("h1", { class: "ah__title", "data-role": "title" }, current.label),
    el("span", { class: "ah__brand", "aria-hidden": "true" }, "دلّني ", el("span", {}, "AI"))
  );

  const tabs = el("nav", { class: "ah__tabs", "aria-label": "التنقل الرئيسي" });
  for (const item of NAV_ITEMS) {
    tabs.appendChild(item.id === page
      ? el("span", { class: "ah__tab is-active", "aria-current": "page", "data-nav": item.id }, item.label)
      : el("a", { class: "ah__tab", href: item.href, "data-nav": item.id }, item.label));
  }

  const tray = el("div", { class: "ah__tray", id: "ring-tray", role: "region", "aria-live": "assertive", "aria-label": "تنبيهات الآن" });
  container.appendChild(el("div", { class: "ah__card" }, bar, tabs));
  container.appendChild(tray);

  // الصينية تُحمَّل ديناميكيًا: أي فشل في تحميلها لا يكسر الرأس ولا التنقل.
  import("./ring-tray.js").then((m) => m.mountRingTray(tray)).catch(() => {});
  return container;
}

function autoMount() {
  const host = document.getElementById("app-header");
  if (host && !host.hasAttribute("data-mounted")) {
    host.setAttribute("data-mounted", "1");
    mountAppHeader(host, { page: host.getAttribute("data-page") });
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMount, { once: true });
  else autoMount();
}
