/* ============================================================
   بيانات التطبيق — المجالات والأدلة
   لإضافة دليل جديد لاحقًا: أضف عنصرًا جديدًا داخل مصفوفة guides
   الخاصة بالمجال المناسب، بنفس الشكل الموجود في الأمثلة الجاهزة.
   ============================================================ */

const DOMAINS = [
  {
    id: "home",
    name: "البيت والصيانة",
    icon: "🏠",
    guides: [
      {
        title: "تسرب ماء بسيط تحت الحوض",
        ready: true,
        steps: [
          "أغلق صنبور التغذية الرئيسي الموجود عادة أسفل الحوض مباشرة (اثنان: للماء البارد والساخن) — أدره باتجاه عقارب الساعة حتى يتوقف.",
          "ضع وعاءً أو منشفة سميكة تحت نقطة التسرب مباشرة لمنع انتشار الماء على الأرضية.",
          "جفّف المنطقة المبللة فورًا لتفادي انزلاق أو تلف الأرضية.",
          "حدد مصدر التسرب بالعين: هل هو من الأنبوب نفسه، من وصلة، أم من خرطوم مرن؟",
          "إذا كانت الوصلة فقط مرتخية قليلًا، جرّب شدّها بمفتاح إنجليزي بلطف.",
          "إن لم يتوقف التسرب، اترك الصنبور الرئيسي مغلقًا واتصل بفني الصرف الصحي."
        ],
        note: "لا تحاول فك الأنابيب بالكامل إن لم تكن متأكدًا من طريقة إعادة تركيبها — هذا قد يحوّل تسربًا بسيطًا إلى فيضان."
      },
      { title: "انقطاع الكهرباء عن غرفة واحدة فقط", ready: false },
      { title: "رائحة كريهة من المطبخ أو الحمام", ready: false },
      { title: "انسداد بالوعة بسيط", ready: false },
      { title: "صرصور أو حشرات في المطبخ", ready: false },
      { title: "جهاز التكييف لا يبرد جيدًا", ready: false }
    ]
  },
  {
    id: "tech",
    name: "التقنية اليومية",
    icon: "📱",
    guides: [
      {
        title: "الهاتف بطيء فجأة",
        ready: true,
        steps: [
          "أعد تشغيل الهاتف بالكامل (إغلاق وتشغيل، وليس فقط قفل الشاشة).",
          "تحقق من مساحة التخزين المتبقية: إذا كانت أقل من 10٪ من السعة الكلية، هذا هو السبب الأكثر شيوعًا للبطء.",
          "أغلق التطبيقات المفتوحة في الخلفية فعليًا من قائمة التطبيقات الأخيرة.",
          "تحقق من وجود تحديث لنظام التشغيل في الإعدادات.",
          "راجع التطبيقات المثبتة حديثًا: إذا بدأ البطء بعد تثبيت تطبيق معين، جرّب حذفه ولاحظ الفرق.",
          "امسح ذاكرة التخزين المؤقت (Cache) للتطبيقات الكبيرة من الإعدادات."
        ],
        note: "إذا استمر البطء بعد كل هذه الخطوات ولاحظت سخونة غير طبيعية أو نفاد بطارية سريع جدًا، قد تكون البطارية نفسها بحاجة لفحص فني معتمد."
      },
      { title: "نسيان كلمة سر حساب مهم", ready: false },
      { title: "مساحة تخزين الهاتف ممتلئة", ready: false },
      { title: "الواي فاي بطيء أو ينقطع", ready: false },
      { title: "شك في اختراق حساب", ready: false },
      { title: "نقل البيانات بين هاتف قديم وجديد بأمان", ready: false }
    ]
  },
  {
    id: "money",
    name: "المال الشخصي",
    icon: "💰",
    guides: [
      {
        title: "راتبي ينتهي قبل نهاية الشهر",
        ready: true,
        steps: [
          "اكتب كل مصروف لمدة 7 أيام فقط، حتى أصغر مصروف، بدون استثناء وبدون حكم على نفسك.",
          "صنّف المصاريف بعد الأسبوع إلى: ثابتة وضرورية، متغيرة وضرورية، وغير ضرورية.",
          "قارن المجموع بالراتب — غالبًا ستجد أن الفئة الثالثة أكبر مما تتوقع.",
          "طبّق قاعدة بسيطة للشهر القادم: نسبة تقريبية لكل فئة، وعدّلها حسب واقعك.",
          "افصل ميزانية الطوارئ عن الحساب اليومي إن أمكن، ولو بمبلغ صغير جدًا شهريًا.",
          "راجع الاشتراكات المتكررة وألغِ ما لا تستخدمه فعليًا."
        ],
        note: "هذه خطوة تشخيص وتنظيم أولية، وليست بديلًا عن استشارة مستشار مالي إذا كانت المشكلة مرتبطة بديون متراكمة أو التزامات كبيرة."
      },
      { title: "كيف أبدأ ميزانية شهرية بسيطة من الصفر", ready: false },
      { title: "أساسيات الادخار حتى بمبلغ صغير جدًا", ready: false },
      { title: "الفرق بين الدين الجيد والدين السيئ", ready: false },
      { title: "مراجعة الاشتراكات الشهرية غير الضرورية", ready: false },
      { title: "خطوات أولية قبل شراء كبير", ready: false }
    ]
  },
  {
    id: "family",
    name: "العلاقات والتربية",
    icon: "❤️",
    guides: [
      { title: "خلاف متكرر مع الشريك حول موضوع واحد", ready: false },
      { title: "طفلي يرفض النوم في وقته", ready: false },
      { title: "وضع حدود صحية مع أفراد العائلة", ready: false },
      { title: "طفل يرفض الطعام", ready: false },
      { title: "نوبة غضب طفل في مكان عام", ready: false },
      { title: "تحسين التواصل مع مراهق منعزل", ready: false }
    ]
  },
  {
    id: "health",
    name: "الصحة اليومية",
    icon: "🩺",
    guides: [
      { title: "صداع متكرر بسيط", ready: false },
      { title: "أرق وصعوبة نوم", ready: false },
      { title: "إرهاق مستمر رغم النوم الكافي", ready: false },
      { title: "حرقة أو انزعاج معدة بسيط بعد الأكل", ready: false },
      { title: "ألم ظهر خفيف من الجلوس الطويل", ready: false }
    ]
  }
];

/* ============================================================
   منطق التنقل بين الشاشات (Home / Domain / Guide)
   ============================================================ */

const appEl = document.getElementById("app");
const backBtn = document.getElementById("backBtn");

let currentView = { name: "home" };

function render() {
  if (currentView.name === "home") return renderHome();
  if (currentView.name === "domain") return renderDomain(currentView.domainId);
  if (currentView.name === "guide") return renderGuide(currentView.domainId, currentView.guideIndex);
}

function renderHome() {
  backBtn.hidden = true;
  const totalReady = DOMAINS.flatMap(d => d.guides).filter(g => g.ready).length;

  appEl.innerHTML = `
    <div class="search-box">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21L16.65 16.65" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input type="text" id="searchInput" placeholder="اكتب مشكلتك... مثال: تسرب ماء" />
    </div>

    <div class="section-title">المجالات</div>
    <div class="domain-grid" id="domainGrid"></div>

    <div class="section-title">الأدلة الجاهزة الآن (${totalReady})</div>
    <div class="guide-list" id="readyList"></div>
  `;

  const grid = document.getElementById("domainGrid");
  DOMAINS.forEach(d => {
    const card = document.createElement("button");
    card.className = "domain-card";
    card.innerHTML = `
      <span class="domain-card__icon">${d.icon}</span>
      <span class="domain-card__name">${d.name}</span>
      <span class="domain-card__count">${d.guides.length} مشكلة</span>
    `;
    card.onclick = () => goTo({ name: "domain", domainId: d.id });
    grid.appendChild(card);
  });

  const readyList = document.getElementById("readyList");
  DOMAINS.forEach(d => {
    d.guides.forEach((g, i) => {
      if (!g.ready) return;
      readyList.appendChild(buildGuideRow(d, g, i));
    });
  });

  document.getElementById("searchInput").addEventListener("input", (e) => {
    const q = e.target.value.trim();
    if (!q) { render(); return; }
    runSearch(q);
  });
}

function runSearch(query) {
  const results = [];
  DOMAINS.forEach(d => {
    d.guides.forEach((g, i) => {
      if (g.title.includes(query)) results.push({ domain: d, guide: g, index: i });
    });
  });

  appEl.innerHTML = `
    <div class="search-box">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21L16.65 16.65" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input type="text" id="searchInput" placeholder="اكتب مشكلتك..." value="${query}" />
    </div>
    <div class="section-title">نتائج البحث (${results.length})</div>
    <div class="guide-list" id="searchResults"></div>
  `;
  const list = document.getElementById("searchResults");
  if (results.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state__icon">🔎</div>لا توجد نتيجة مطابقة بعد.<br/>جرّب المساعد الذكي أو تصفّح المجالات.</div>`;
  } else {
    results.forEach(r => list.appendChild(buildGuideRow(r.domain, r.guide, r.index)));
  }
  document.getElementById("searchInput").addEventListener("input", (e) => runSearch(e.target.value.trim()));
}

function buildGuideRow(domain, guide, index) {
  const row = document.createElement("button");
  row.className = "guide-row";
  row.innerHTML = `
    <span class="guide-row__index">${domain.icon}</span>
    <span class="guide-row__title">${guide.title}</span>
    <span class="guide-row__badge ${guide.ready ? "guide-row__badge--ready" : ""}">${guide.ready ? "جاهز" : "قريبًا"}</span>
  `;
  row.onclick = () => goTo({ name: "guide", domainId: domain.id, guideIndex: index });
  return row;
}

function renderDomain(domainId) {
  const domain = DOMAINS.find(d => d.id === domainId);
  backBtn.hidden = false;

  appEl.innerHTML = `
    <div class="section-title">${domain.icon} ${domain.name}</div>
    <div class="guide-list" id="domainGuideList"></div>
  `;
  const list = document.getElementById("domainGuideList");
  domain.guides.forEach((g, i) => list.appendChild(buildGuideRow(domain, g, i)));
}

function renderGuide(domainId, guideIndex) {
  const domain = DOMAINS.find(d => d.id === domainId);
  const guide = domain.guides[guideIndex];
  backBtn.hidden = false;

  if (!guide.ready) {
    appEl.innerHTML = `
      <div class="guide-header">
        <div class="guide-header__domain">${domain.icon} ${domain.name}</div>
        <h2 class="guide-header__title">${guide.title}</h2>
      </div>
      <div class="empty-state">
        <div class="empty-state__icon">✍️</div>
        هذا الدليل قيد الكتابة حاليًا وسيُضاف قريبًا.
      </div>
      <button class="btn btn--primary" id="askAboutThis">اسأل المساعد عن هذه المشكلة الآن</button>
    `;
    document.getElementById("askAboutThis").onclick = openSheet;
    return;
  }

  appEl.innerHTML = `
    <div class="guide-header">
      <div class="guide-header__domain">${domain.icon} ${domain.name}</div>
      <h2 class="guide-header__title">${guide.title}</h2>
    </div>
    <div id="stepsWrap"></div>
    ${guide.note ? `<div class="callout">⚠️ ${guide.note}</div>` : ""}
    <button class="btn btn--outline" id="notSolved">لم يحل مشكلتي، اسأل المساعد</button>
  `;
  const wrap = document.getElementById("stepsWrap");
  guide.steps.forEach((s, i) => {
    const card = document.createElement("div");
    card.className = "step-card";
    card.innerHTML = `<span class="step-card__num">${i + 1}</span><span class="step-card__text">${s}</span>`;
    wrap.appendChild(card);
  });
  document.getElementById("notSolved").onclick = openSheet;
}

function goTo(view) {
  currentView = view;
  window.scrollTo(0, 0);
  render();
}

backBtn.addEventListener("click", () => {
  if (currentView.name === "guide") {
    goTo({ name: "domain", domainId: currentView.domainId });
  } else {
    goTo({ name: "home" });
  }
});

/* ============================================================
   الشيت السفلي لمساعد الذكاء الاصطناعي (نص تمهيدي حاليًا)
   ============================================================ */

const overlay = document.getElementById("sheetOverlay");
const sheet = document.getElementById("assistantSheet");

function openSheet() {
  overlay.classList.add("open");
  sheet.classList.add("open");
}
function closeSheet() {
  overlay.classList.remove("open");
  sheet.classList.remove("open");
}
document.getElementById("assistantFab").addEventListener("click", openSheet);
document.getElementById("sheetCloseBtn").addEventListener("click", closeSheet);
overlay.addEventListener("click", closeSheet);

render();
