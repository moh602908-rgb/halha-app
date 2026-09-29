/* ============================================================
   today-add.js — Organizer Core: نموذج إضافة عنصر جديد (Today UI)
   ============================================================
   طبقة واجهة جديدة، مستقلة عن app.js/ask.js. لا شبكة، لا AI.

   الاستيراد: createOccurrence من organizer-crud.js، createRecurringSeries
   من organizer-recurrence.js (كلاهما بلا أي تعديل). لا وصول مباشر
   لـIndexedDB هنا.

   يطبّق حرفيًا: البند 2 (عنوان فقط إلزامي، حفظ فوري بلا شاشات تأكيد
   وسيطة، عنوان فارغ لا يُحفَظ)، البند 3 (حقل غير مُلمَس لا يُحفَظ
   بقيمة افتراضية)، البند 4 (بلا وقت=مهمة؛ وقت واحد=ملتبس؛ بداية+نهاية
   =موعد تلقائيًا)، البند 5 (مفتاح تذكير⟷موعد، افتراضي "تذكير"، غير
   محفوظ حتى الحفظ)، البند 6 (تكرار يومي/أسبوعي/شهري — anchor_day
   يُشتَق تلقائيًا من تاريخ العنصر نفسه، لا حقل منفصل، ولا نضيف حقل
   "interval" مخصص أو "series_end" عند الإنشاء — غير مذكورين في نص
   البند 6 لإنشاء عنصر جديد).

   Foundation v2: endTime وdomain وpriority وnote تُحفظ للعناصر المفردة وللسلاسل المتكررة (تنتقل لكل حدوث).
   endTime <= time مسموح ويعني عبور منتصف الليل (تُحسب المدة دائريًا)؛ الممنوع الوحيد تساوي endTime مع time.
   للموعد). البند 4/8 يفترضان وجود "وقت نهاية صريح" للموعد، ولا حقل
   له في نموذج البيانات الحالي — إضافة عادية بلا فهرس، لا تحتاج أي
   تعديل على organizer-db.js (راجع التقرير). لا يُستخدَم في أي منطق
   تصنيف/ترتيب/تأجيل — عرض فقط.
   ============================================================ */

import { createOccurrence } from "./organizer-crud.js";
import { createRecurringSeries } from "./organizer-recurrence.js";
import {
  KNOWN_DOMAINS, DOMAIN_LABELS_AR, PRIORITIES, PRIORITY_LABELS_AR, NOTE_MAX_LENGTH, pickExtraFields,
} from "./organizer-model.js";

const TITLE_MAX = 200; // البند 3: "حد أقصى معقول (تفصيل تنفيذي لاحق)" — قيمة تنفيذية مبدئية، سهل تعديلها هنا فقط
const WEEKDAYS = [
  { v: 0, label: "الأحد" }, { v: 1, label: "الاثنين" }, { v: 2, label: "الثلاثاء" },
  { v: 3, label: "الأربعاء" }, { v: 4, label: "الخميس" }, { v: 5, label: "الجمعة" }, { v: 6, label: "السبت" },
];

const p2 = (n) => String(n).padStart(2, "0");
const todayLocalDateStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
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

function newId() {
  const uuid = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `item_${uuid}`;
}

/**
 * يبني نموذج الإضافة كعنصر DOM جاهز للإدراج (Modal كامل يشمل الخلفية).
 * @param {{onCreated: () => void, onCancel: () => void}} handlers
 * @returns {HTMLElement}
 */
export function buildAddModal({ onCreated, onCancel }) {
  const backdrop = el("div", { class: "modal-backdrop" });
  const card = el("div", { class: "modal-card", role: "dialog", "aria-modal": "true" });
  backdrop.appendChild(card);

  card.appendChild(el("h2", { class: "modal-card__title" }, "إضافة جديد"));

  const errorBox = el("p", { class: "field-error hidden" });

  const titleInput = el("input", {
    type: "text", class: "input", placeholder: "العنوان (إلزامي)", maxlength: String(TITLE_MAX),
  });

  const dateInput = el("input", { type: "date", class: "input", value: todayLocalDateStr() });
  const timeInput = el("input", { type: "time", class: "input" });
  const endTimeInput = el("input", { type: "time", class: "input", disabled: "disabled" });

  // Foundation v2: المجال والأولوية والملاحظة (اختيارية؛ الفارغ لا يُحفظ).
  const domainSelect = el(
    "select", { class: "input" },
    el("option", { value: "" }, "بدون مجال"),
    ...KNOWN_DOMAINS.map((d) => el("option", { value: d }, DOMAIN_LABELS_AR[d]))
  );
  const prioritySelect = el(
    "select", { class: "input" },
    el("option", { value: "" }, "بدون أولوية"),
    ...PRIORITIES.map((pr) => el("option", { value: pr }, PRIORITY_LABELS_AR[pr]))
  );
  const noteInput = el("textarea", {
    class: "input", rows: "2", maxlength: String(NOTE_MAX_LENGTH), placeholder: "ملاحظة (اختياري)",
  });

  // مفتاح تذكير⟷موعد — يظهر فقط عند وقت واحد بلا نهاية (البند 5)
  const reminderRadio = el("input", { type: "radio", name: "kind", value: "reminder", checked: "checked" });
  const appointmentRadio = el("input", { type: "radio", name: "kind", value: "appointment" });
  const kindRow = el(
    "div", { class: "radio-row hidden" },
    el("label", {}, reminderRadio, " تذكير"),
    el("label", {}, appointmentRadio, " موعد")
  );

  const typeHint = el("p", { class: "type-hint" }, "سيُحفَظ كـ: مهمة");

  // التكرار
  const recurrenceSelect = el(
    "select", { class: "input" },
    el("option", { value: "none" }, "بلا تكرار"),
    el("option", { value: "daily" }, "يومي"),
    el("option", { value: "weekly" }, "أسبوعي (أيام محددة)"),
    el("option", { value: "monthly" }, "شهري (نفس رقم اليوم)")
  );
  const weekdayChecks = WEEKDAYS.map(({ v, label }) => {
    const cb = el("input", { type: "checkbox", value: String(v) });
    return { v, box: el("label", { class: "weekday-check" }, cb, label), cb };
  });
  const weekdayRow = el("div", { class: "weekday-checks hidden" }, ...weekdayChecks.map((w) => w.box));
  const monthlyNote = el("p", { class: "type-hint hidden" });

  function updateTypeUI() {
    const hasTime = !!timeInput.value;
    endTimeInput.disabled = !hasTime;
    if (!hasTime) {
      endTimeInput.value = "";
      kindRow.classList.add("hidden");
      typeHint.textContent = "سيُحفَظ كـ: مهمة";
      return;
    }
    if (endTimeInput.value) {
      kindRow.classList.add("hidden");
      typeHint.textContent = "سيُحفَظ كـ: موعد (بداية ونهاية محددتان)";
    } else {
      kindRow.classList.remove("hidden");
      const kind = appointmentRadio.checked ? "موعد" : "تذكير";
      typeHint.textContent = `سيُحفَظ كـ: ${kind}`;
    }
  }
  timeInput.addEventListener("input", updateTypeUI);
  endTimeInput.addEventListener("input", updateTypeUI);
  reminderRadio.addEventListener("change", updateTypeUI);
  appointmentRadio.addEventListener("change", updateTypeUI);

  recurrenceSelect.addEventListener("change", () => {
    const v = recurrenceSelect.value;
    weekdayRow.classList.toggle("hidden", v !== "weekly");
    monthlyNote.classList.toggle("hidden", v !== "monthly");
    if (v === "monthly") {
      const day = new Date(dateInput.value || todayLocalDateStr()).getDate();
      monthlyNote.textContent = `سيتكرر في اليوم ${day} من كل شهر (حسب تاريخ العنصر أعلاه)`;
    }
    if (v === "weekly") {
      // تحديد يوم أسبوع تاريخ العنصر افتراضيًا، لتفادي إرسال نموذج بلا أي يوم محدَّد
      const wd = new Date(`${dateInput.value || todayLocalDateStr()}T00:00:00`).getDay();
      weekdayChecks.forEach((w) => { w.cb.checked = w.v === wd; });
    }
  });
  dateInput.addEventListener("change", () => {
    if (recurrenceSelect.value === "monthly") {
      const day = new Date(dateInput.value).getDate();
      monthlyNote.textContent = `سيتكرر في اليوم ${day} من كل شهر (حسب تاريخ العنصر أعلاه)`;
    }
  });

  const saveBtn = el("button", { class: "btn btn--complete" }, "حفظ");
  const cancelBtn = el("button", { class: "btn btn--ghost" }, "إلغاء");
  cancelBtn.addEventListener("click", () => onCancel());

  saveBtn.addEventListener("click", async () => {
    errorBox.classList.add("hidden");
    const title = titleInput.value.trim();
    if (!title) {
      errorBox.textContent = "العنوان مطلوب.";
      errorBox.classList.remove("hidden");
      return;
    }
    const date = dateInput.value || todayLocalDateStr();
    const time = timeInput.value || null;
    const endTime = time && endTimeInput.value ? endTimeInput.value : null;
    let itemType;
    if (!time) itemType = "task";
    else if (endTime) itemType = "appointment";
    else itemType = appointmentRadio.checked ? "appointment" : "reminder";

    // endTime أصغر من/يساوي time لا تُرفض هنا: قد تعني عبور منتصف الليل (تُحسب دائريًا في organizer-model.js).
    // المرفوض الوحيد هو التساوي الحرفي (مدة صفر/24 ساعة ملتبسة)، وorganizer-crud.js يرفضه أصلًا.
    if (endTime && endTime === time) {
      errorBox.textContent = "وقت النهاية لا يمكن أن يساوي وقت البداية.";
      errorBox.classList.remove("hidden");
      return;
    }
    const extras = pickExtraFields({ domain: domainSelect.value, priority: prioritySelect.value, note: noteInput.value });

    const recType = recurrenceSelect.value;
    saveBtn.disabled = true;
    try {
      if (recType === "none") {
        const rec = { occ_key: newId(), title, itemType, date, time, status: "upcoming" };
        rec.root_id = rec.occ_key;
        Object.assign(rec, extras);
        if (endTime) rec.endTime = endTime;
        await createOccurrence(rec);
      } else {
        let recurrence;
        if (recType === "daily") {
          recurrence = { type: "daily", interval: 1 };
        } else if (recType === "weekly") {
          const days = weekdayChecks.filter((w) => w.cb.checked).map((w) => w.v);
          if (days.length === 0) throw new Error("اختر يومًا واحدًا على الأقل للتكرار الأسبوعي.");
          recurrence = { type: "weekly", weekdays: days, interval: 1 };
        } else {
          recurrence = { type: "monthly", anchor_day: new Date(`${date}T00:00:00`).getDate(), interval: 1 };
        }
        await createRecurringSeries({ root_id: newId(), title, itemType, time, date, recurrence, endTime, ...extras });
      }
      onCreated();
    } catch (err) {
      errorBox.textContent = (err && err.message) || "تعذّر الحفظ.";
      errorBox.classList.remove("hidden");
    } finally {
      saveBtn.disabled = false;
    }
  });

  card.appendChild(errorBox);
  card.appendChild(el("label", { class: "form-label" }, "العنوان", titleInput));
  card.appendChild(
    el("div", { class: "form-row" },
      el("label", { class: "form-label" }, "التاريخ", dateInput),
      el("label", { class: "form-label" }, "الوقت (اختياري)", timeInput),
      el("label", { class: "form-label" }, "وقت النهاية (اختياري)", endTimeInput)
    )
  );
  card.appendChild(
    el("div", { class: "form-row" },
      el("label", { class: "form-label" }, "المجال", domainSelect),
      el("label", { class: "form-label" }, "الأولوية", prioritySelect)
    )
  );
  card.appendChild(el("label", { class: "form-label" }, "ملاحظة", noteInput));
  card.appendChild(typeHint);
  card.appendChild(kindRow);
  card.appendChild(el("label", { class: "form-label" }, "التكرار", recurrenceSelect));
  card.appendChild(weekdayRow);
  card.appendChild(monthlyNote);
  card.appendChild(el("div", { class: "modal-card__actions" }, saveBtn, cancelBtn));

  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) onCancel(); });
  return backdrop;
}
