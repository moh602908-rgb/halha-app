/* ============================================================
   owner-dashboard.js — منطق موحّد لصفحتَي owner-login و owner-dashboard
   دلّني AI — الإصدار الأول (v1)

   يلتزم هذا الملف بالكامل بما يلي:
   - لا تعديل ولا افتراض تغيير على api/_lib/ownerAuth.js أو أي نقطة owner-*.
   - المصادقة تبقى بلا حالة (Stateless) من جهة الخادم تمامًا كما هي:
     كل طلب يُرفق Header الثابت x-owner-access-key، دون كوكيز ودون JWT.
   - "الجلسة" الوحيدة الموجودة هنا هي تخزين مؤقت للمفتاح في
     sessionStorage (جانب المتصفح فقط)، يُمسح تلقائيًا عند إغلاق
     التبويب/المتصفح، ولا يمثّل أي نظام جلسات على الخادم.
   ============================================================ */

(function () {
  "use strict";

  var STORAGE_KEY = "dallini_owner_key";
  var HEADER_NAME = "x-owner-access-key";
  var VERIFY_ENDPOINT = "/api/owner-status";

  // ------------------------------------------------------------
  // تعريب طبقة العرض فقط — لا علاقة لهذا القسم بالمصادقة أو الشبكة
  // ------------------------------------------------------------

  var ARABIC_LABELS = {
    date: "التاريخ",
    last_updated: "آخر تحديث",

    "config.enableIntentLayer": "طبقة تحليل النية مفعّلة",
    "config.activeProvider": "مزود الذكاء الاصطناعي الحالي",
    "config.defaultModel": "النموذج الافتراضي",
    "usage.dailyGlobalCount": "عدد الطلبات اليوم",
    "usage.dailyGlobalCap": "السقف اليومي المسموح",
    "usage.withinCap": "ضمن السقف المسموح",
    "window.minutes": "مدة نافذة المراقبة (دقائق)",
    "window.rejectedInWindow": "المرفوض خلال النافذة الحالية",
    "window.floodActive": "حالة الإغراق نشطة الآن",
    "events.too_fast": "طلبات سريعة جدًا",
    "events.quota_limit": "تجاوز السقف اليومي",
    "events.origin_block": "حظر مصدر غير موثوق",
    "events.validation_error": "خطأ تحقق من المدخلات",
    "events.method_not_allowed": "طريقة طلب غير مسموحة",
    "events.unsupported_content_type": "نوع محتوى غير مدعوم",
    "events.bad_request": "طلب غير صالح",
    "events.empty_question": "سؤال فارغ",
    "events.intent_injection_block": "محاولة حقن تعليمات",
    "events.owner_auth_failed": "فشل دخول لوحة المالك",
    "events.reject_flood_detected": "نشاط غير طبيعي (إغراق)",
    "events.provider_error": "خطأ من مزود الذكاء الاصطناعي",

    provider_name: "اسم مزود الذكاء الاصطناعي",
    model_name: "اسم النموذج",
    provider_error_count_today: "أخطاء المزوّد اليوم",

    requests_today: "عدد الطلبات اليوم",
    daily_quota_limit: "السقف اليومي",
    quota_usage_percentage: "نسبة استهلاك السقف (%)",
    quota_limit_hits_today: "مرات بلوغ السقف اليوم",

    origin_block_count: "محاولات من مصدر غير موثوق",
    validation_error_count: "أخطاء تحقق من المدخلات",
    intent_injection_block_count: "محاولات حقن تعليمات",
    quota_limit_count: "مرات بلوغ السقف اليومي",
    provider_error_count: "أخطاء مزود الذكاء الاصطناعي",
    owner_auth_failed_count: "محاولات دخول فاشلة للوحة المالك",
    global_flood_detected: "نشاط غير طبيعي حاليًا",

    protection_scope: "نطاق الحماية",
    base_protection_enabled: "الحماية الأساسية مفعّلة",
    auto_block_enabled: "الحظر التلقائي مفعّل",
    calm_mode_enabled: "وضع الهدوء مفعّل",
    strict_mode_enabled: "الوضع الصارم مفعّل",

    activity_00_06_today: "نشاط الأسئلة (00:00 - 06:00)",
    activity_06_12_today: "نشاط الأسئلة (06:00 - 12:00)",
    activity_12_18_today: "نشاط الأسئلة (12:00 - 18:00)",
    activity_18_24_today: "نشاط الأسئلة (18:00 - 24:00)",
    activity_night_today: "نشاط الليل (00-06 و18-24)",
    activity_day_today: "نشاط النهار (06-12 و12-18)",
    ai_requests_today: "طلبات الذكاء الاصطناعي (اليوم)",
    ai_requests_week: "طلبات الذكاء الاصطناعي (أسبوعيًا)",
    ai_requests_month: "طلبات الذكاء الاصطناعي (شهريًا)",
    app_activity_today: "نشاط التطبيق (اليوم)",
    app_activity_week: "نشاط التطبيق (أسبوعيًا)",
    app_activity_month: "نشاط التطبيق (شهريًا)",
    rejected_or_failed_week: "طلبات مرفوضة أو فاشلة (أسبوعيًا)",
    rejected_or_failed_month: "طلبات مرفوضة أو فاشلة (شهريًا)",
    provider_errors_today: "أخطاء مزود الذكاء الاصطناعي (اليوم)",
    provider_errors_week: "أخطاء مزود الذكاء الاصطناعي (أسبوعيًا)",
    provider_errors_month: "أخطاء مزود الذكاء الاصطناعي (شهريًا)",
    injection_attempts_today: "محاولات حقن تعليمات (اليوم)",
    injection_attempts_week: "محاولات حقن تعليمات (أسبوعيًا)",
    injection_attempts_month: "محاولات حقن تعليمات (شهريًا)",
    protection_bypass_today: "محاولات تجاوز الحماية (اليوم)",
    protection_bypass_week: "محاولات تجاوز الحماية (أسبوعيًا)",
    protection_bypass_month: "محاولات تجاوز الحماية (شهريًا)",
    abnormal_requests_today: "طلبات غير طبيعية (اليوم)",
    abnormal_requests_week: "طلبات غير طبيعية (أسبوعيًا)",
    abnormal_requests_month: "طلبات غير طبيعية (شهريًا)",
    owner_login_failed_today: "محاولات دخول لوحة المالك الفاشلة (اليوم)",
    owner_login_failed_week: "محاولات دخول لوحة المالك الفاشلة (أسبوعيًا)",
    owner_login_failed_month: "محاولات دخول لوحة المالك الفاشلة (شهريًا)"
  };

  // ترجمة قيم نصية معروفة (وليس أسماء الحقول) — القيم غير المدرَجة
  // هنا (كأسماء المزوّدين والنماذج) تبقى كما هي بصفتها أسماء منتج.
  var ARABIC_VALUE_LABELS = {
    "system-wide": "على مستوى النظام"
  };

  // يحوّل "2026-09-09T14:03:00.000Z" إلى "2026-09-09 14:03" — بلا
  // الاعتماد على أي تنسيق محلي (Intl) تفاديًا لأي تغيير غير متوقع
  // في نظام الأرقام؛ الأرقام تبقى 0-9 دائمًا بهذه الطريقة.
  function formatIfIsoDateTime(value) {
    if (typeof value !== "string") return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
    return value.replace("T", " ").slice(0, 16);
  }

  // يسطّح كائنًا متداخلًا إلى مفاتيح بصيغة "أب.ابن" لعرضها كصفوف
  // مفهومة بدل JSON خام — لا يغيّر أي قيمة، فقط شكل العرض.
  function flattenForDisplay(obj, prefix) {
    var out = {};
    Object.keys(obj || {}).forEach(function (key) {
      var value = obj[key];
      var flatKey = prefix ? prefix + "." + key : key;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        var nested = flattenForDisplay(value, flatKey);
        Object.keys(nested).forEach(function (nk) { out[nk] = nested[nk]; });
      } else {
        out[flatKey] = value;
      }
    });
    return out;
  }

  // ------------------------------------------------------------
  // أدوات مشتركة
  // ------------------------------------------------------------

  function getStoredKey() {
    try {
      return sessionStorage.getItem(STORAGE_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function setStoredKey(key) {
    try {
      sessionStorage.setItem(STORAGE_KEY, key);
    } catch (e) {
      /* تجاهل بيئات لا تدعم sessionStorage دون كسر الصفحة */
    }
  }

  function clearStoredKey() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* تجاهل */
    }
  }

  function goToLogin() {
    window.location.href = "./owner-login.html";
  }

  function goToDashboard() {
    window.location.href = "./owner-dashboard.html";
  }

  /**
   * نداء موحّد لأي نقطة owner-*: يُرفق Header المفتاح تلقائيًا،
   * ويُعيد كائن النتيجة أو يرمي خطأ يحمل حالة الرد (status).
   */
  function ownerFetch(endpoint) {
    var key = getStoredKey();
    return fetch(endpoint, {
      method: "GET",
      headers: {
        "accept": "application/json",
        // ownerAuth.js يقرأ هذا الاسم بالضبط — لا تغييره.
        // (اسم الثابت HEADER_NAME أعلاه للتوثيق فقط داخل هذا الملف)
        "x-owner-access-key": key
      }
    }).then(function (response) {
      if (!response.ok) {
        var err = new Error("owner_request_failed");
        err.status = response.status;
        throw err;
      }
      return response.json();
    });
  }

  // ------------------------------------------------------------
  // عرض عام لأي كائن JSON كقائمة مفتاح/قيمة (دون افتراض حقول محددة)
  // ------------------------------------------------------------

  function formatKeyLabel(key) {
    if (Object.prototype.hasOwnProperty.call(ARABIC_LABELS, key)) return ARABIC_LABELS[key];
    // لا نعرض أي مفتاح تقني إنجليزي مهما كان — تسمية آمنة عامة بدلاً منه.
    return "حقل غير معروف";
  }

  function formatValue(value) {
    if (value === null || value === undefined) return "—";
    if (typeof value === "boolean") return value ? "نعم" : "لا";
    var isoFormatted = formatIfIsoDateTime(value);
    if (isoFormatted !== null) return isoFormatted;
    if (typeof value === "string" && Object.prototype.hasOwnProperty.call(ARABIC_VALUE_LABELS, value)) {
      return ARABIC_VALUE_LABELS[value];
    }
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch (e) {
        return String(value);
      }
    }
    return String(value);
  }

  function renderKeyValueList(obj) {
    var list = document.createElement("ul");
    list.className = "owner-kv";

    var flat = flattenForDisplay(obj, "");
    var keys = Object.keys(flat);
    if (keys.length === 0) {
      var empty = document.createElement("p");
      empty.className = "owner-card__loading";
      empty.textContent = "لا توجد بيانات لعرضها حاليًا.";
      return empty;
    }

    keys.forEach(function (key) {
      var row = document.createElement("li");
      row.className = "owner-kv__row";

      var k = document.createElement("span");
      k.className = "owner-kv__key";
      k.textContent = formatKeyLabel(key);

      var v = document.createElement("span");
      v.className = "owner-kv__value";
      v.textContent = formatValue(flat[key]);

      row.appendChild(k);
      row.appendChild(v);
      list.appendChild(row);
    });

    return list;
  }

  function setStatusPill(pillEl, kind, text) {
    pillEl.className = "owner-card__status owner-card__status--" + kind;
    pillEl.textContent = text;
  }

  // ------------------------------------------------------------
  // منطق صفحة الدخول
  // ------------------------------------------------------------

  function initLoginPage(form) {
    var input = document.getElementById("owner-key");
    var errorEl = document.getElementById("owner-login-error");
    var submitBtn = document.getElementById("owner-login-submit");

    // إن كان هناك مفتاح محفوظ بالفعل من جلسة سابقة، انتقل مباشرة للوحة.
    if (getStoredKey()) {
      goToDashboard();
      return;
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var candidateKey = input.value.trim();

      errorEl.hidden = true;
      if (!candidateKey) return;

      submitBtn.disabled = true;
      submitBtn.textContent = "جارِ التحقق…";

      fetch(VERIFY_ENDPOINT, {
        method: "GET",
        headers: {
          "accept": "application/json",
          "x-owner-access-key": candidateKey
        }
      })
        .then(function (response) {
          if (response.ok) {
            setStoredKey(candidateKey);
            goToDashboard();
            return;
          }
          // أي فشل (بما فيه 404 الموحّد من ownerAuth، أو تهدئة نشطة)
          // يُعرض برسالة واحدة عامة، دون كشف تفاصيل السبب الفعلي.
          errorEl.textContent = "مفتاح الدخول غير صحيح.";
          errorEl.hidden = false;
        })
        .catch(function () {
          errorEl.textContent = "تعذّر الاتصال بالخادم. تحقّق من الإنترنت وحاول مجددًا.";
          errorEl.hidden = false;
        })
        .finally(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = "دخول";
        });
    });
  }

  // ------------------------------------------------------------
  // منطق صفحة اللوحة الرئيسية
  // ------------------------------------------------------------

  function loadCard(cardEl) {
    var endpoint = cardEl.getAttribute("data-endpoint");
    var body = cardEl.querySelector("[data-card-body]");
    var pill = cardEl.querySelector("[data-status-pill]");

    return ownerFetch(endpoint)
      .then(function (data) {
        body.innerHTML = "";
        body.appendChild(renderKeyValueList(data));
        setStatusPill(pill, "ok", "متصل");
      })
      .catch(function (err) {
        if (err && err.status === 404) {
          // فشل مصادقة موحّد من ownerAuth: المفتاح المحفوظ لم يعد صالحًا
          // (خطأ، أو تهدئة نشطة، أو تغيّر الإعداد على الخادم).
          clearStoredKey();
          goToLogin();
          return;
        }
        body.innerHTML = "";
        var p = document.createElement("p");
        p.className = "owner-card__error";
        p.textContent = "تعذّر جلب البيانات لهذا القسم.";
        body.appendChild(p);
        setStatusPill(pill, "error", "تعذّر الاتصال");
      });
  }

  function initDashboardPage(grid) {
    if (!getStoredKey()) {
      goToLogin();
      return;
    }

    var cards = grid.querySelectorAll(".owner-card[data-endpoint]");
    cards.forEach(function (cardEl) {
      loadCard(cardEl);
    });

    var logoutBtn = document.getElementById("owner-logout-btn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function () {
        clearStoredKey();
        goToLogin();
      });
    }
  }

  // ------------------------------------------------------------
  // نقطة الدخول: تحديد الصفحة الحالية عبر العناصر الموجودة فعليًا
  // ------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", function () {
    var loginForm = document.getElementById("owner-login-form");
    var dashboardGrid = document.getElementById("owner-dashboard-grid");

    if (loginForm) {
      initLoginPage(loginForm);
    } else if (dashboardGrid) {
      initDashboardPage(dashboardGrid);
    }
  });
})();
