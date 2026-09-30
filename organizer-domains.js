/* ============================================================
   organizer-domains.js — قوالب عرض/إدخال لكل مجال، فوق تخزين موحَّد
   ============================================================
   لا مخزن جديد، لا حقل IndexedDB جديد. كل "مجال" (وثائق/سيارة/فواتير...)
   هو occurrence عادي بحقل domain الموجود من الحزمة 1، والفرق بينها هو
   فقط: النوع الافتراضي، هل تتطلب وقت نهاية، وتلميح إدخال إضافي.
   إضافة مجال جديد لاحقًا = سطر واحد هنا، بلا تعديل في organizer-db.js.
   ============================================================ */

import { KNOWN_DOMAINS, DOMAIN_LABELS_AR } from "./organizer-model.js";

/** قالب لكل مجال: defaultItemType (المبدئي عند الإضافة)، requiresEndTime (تلميح واجهة فقط، لا فرض)، hint (نص مساعد). */
export const DOMAIN_TEMPLATES = Object.freeze({
  documents: { defaultItemType: "reminder", requiresEndTime: false, hint: "مثال: تجديد الهوية، جواز السفر" },
  car: { defaultItemType: "reminder", requiresEndTime: false, hint: "مثال: صيانة دورية، تجديد الاستمارة" },
  bills: { defaultItemType: "reminder", requiresEndTime: false, hint: "مثال: فاتورة الكهرباء، الماء، الإنترنت" },
  family: { defaultItemType: "task", requiresEndTime: false, hint: "مثال: موعد طبيب لأحد أفراد الأسرة" },
  study: { defaultItemType: "task", requiresEndTime: false, hint: "مثال: واجب، امتحان، مذاكرة" },
  work: { defaultItemType: "appointment", requiresEndTime: true, hint: "مثال: اجتماع، مهمة عمل" },
  travel: { defaultItemType: "appointment", requiresEndTime: true, hint: "مثال: رحلة، حجز، موعد مطار" },
  shopping: { defaultItemType: "task", requiresEndTime: false, hint: "مثال: مشتريات، قائمة تسوق" },
  occasions: { defaultItemType: "reminder", requiresEndTime: false, hint: "مثال: عيد ميلاد، مناسبة عائلية" },
});

/** قالب مجال معيَّن، أو null لمجال غير معروف (لا يرمي — القوالب اختيارية دائمًا). */
export function getDomainTemplate(domain) {
  return domain && DOMAIN_TEMPLATES[domain] ? DOMAIN_TEMPLATES[domain] : null;
}

/** كل المجالات مع تسميتها العربية وقالبها، بترتيب KNOWN_DOMAINS الثابت (لعرض قائمة اختيار). */
export function listDomainsWithTemplates() {
  return KNOWN_DOMAINS.map((d) => ({ domain: d, label: DOMAIN_LABELS_AR[d], template: DOMAIN_TEMPLATES[d] }));
}
