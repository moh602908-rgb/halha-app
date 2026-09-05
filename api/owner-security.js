/* ============================================================
   /api/owner-security — الأمان والتلاعب (Owner Dashboard)
   ============================================================
   ثمانية حقول فقط حسب العقد المعتمد. لا daily_totals في هذا
   الإصدار (مؤجَّل لغياب تخزين دائم يتجاوز اليوم الحالي — بند
   Redis/Upstash المؤجَّل أصلًا).

   كل الحقول تُقرأ من getSnapshot() الموجودة أصلًا في monitor.js —
   لا تعديل على monitor.js أو أي ملف آخر. validation_error_count هو
   الحقل الوحيد الذي يحتاج تجميعًا محليًا (خمس فئات مجمّعة في رقم
   واحد)، ويتم هذا التجميع هنا فقط، وليس في monitor.js نفسه.

   GET فقط، محمي بحارس المصادقة المشترك في api/_lib/ownerAuth.js.
   ============================================================ */

export const config = { runtime: "edge" };

import { getSnapshot } from "./_lib/monitor.js";
import { guardOwnerRequest, jsonResponse } from "./_lib/ownerAuth.js";

// تجميع محلي لخمس فئات "رفض بسبب الصياغة" في رقم واحد فقط، حسب
// العقد المعتمد — لا تعديل على monitor.js، هذا الجمع يحدث هنا فقط.
function sumValidationErrors(counts) {
  if (!counts) return 0;
  const keys = [
    "validation_error",
    "method_not_allowed",
    "unsupported_content_type",
    "bad_request",
    "empty_question"
  ];
  let total = 0;
  for (const key of keys) {
    total += counts[key] || 0;
  }
  return total;
}

export default async function handler(req) {
  const rejection = await guardOwnerRequest(req);
  if (rejection) return rejection;

  const snapshot = getSnapshot();
  const counts = snapshot && snapshot.counts ? snapshot.counts : null;
  const floodActive = snapshot && snapshot.window ? snapshot.window.floodActive === true : false;

  return jsonResponse({
    origin_block_count: counts ? counts.origin_block : 0,
    validation_error_count: sumValidationErrors(counts),
    intent_injection_block_count: counts ? counts.intent_injection_block : 0,
    quota_limit_count: counts ? counts.quota_limit : 0,
    provider_error_count: counts ? counts.provider_error : 0,
    owner_auth_failed_count: counts ? counts.owner_auth_failed : 0,
    global_flood_detected: floodActive,
    last_updated: new Date().toISOString()
  }, 200);
}
