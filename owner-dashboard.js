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
    return String(key).replace(/_/g, " ");
  }

  function formatValue(value) {
    if (value === null || value === undefined) return "—";
    if (typeof value === "boolean") return value ? "نعم" : "لا";
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

    var keys = Object.keys(obj || {});
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
      v.textContent = formatValue(obj[key]);

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
