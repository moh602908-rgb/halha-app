/* ============================================================
   /api/owner-ai-status — حالة API والذكاء الاصطناعي (Owner Dashboard)
   ============================================================
   أربعة حقول فقط حسب العقد المعتمد. لا connection_status ولا
   success_rate_24h ولا average_response_time_ms في هذا الإصدار —
   لا مصدر بيانات موثوق لها حاليًا (ask.js يسجّل فشل الاستدعاء فقط،
   لا نجاحًا ولا زمن استجابة). تُصمَّم في خطوة منفصلة تمامًا لاحقًا
   تشمل تعديلاً فعليًا على ask.js، بموافقة صريحة إضافية.

   provider_name وmodel_name من CONFIG مباشرة (بلا أي استدعاء حي
   للمزوّد). provider_error_count_today من نفس getSnapshot() المستخدم
   في owner-security.js. لا تعديل على ask.js أو monitor.js أو
   config.js أو أي ملف آخر.

   GET فقط، محمي بحارس المصادقة المشترك في api/_lib/ownerAuth.js.
   ============================================================ */

export const config = { runtime: "edge" };

import { CONFIG } from "./_lib/config.js";
import { getSnapshot } from "./_lib/monitor.js";
import { guardOwnerRequest, jsonResponse } from "./_lib/ownerAuth.js";

export default async function handler(req) {
  const rejection = await guardOwnerRequest(req);
  if (rejection) return rejection;

  const snapshot = getSnapshot();

  return jsonResponse({
    provider_name: CONFIG.ACTIVE_PROVIDER,
    model_name: CONFIG.DEFAULT_MODEL,
    provider_error_count_today: snapshot && snapshot.counts ? snapshot.counts.provider_error : 0,
    last_updated: new Date().toISOString()
  }, 200);
}
