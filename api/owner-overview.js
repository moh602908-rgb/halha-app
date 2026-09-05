/* ============================================================
   /api/owner-overview — ملخص سريع لحالة النظام (Owner Dashboard)
   ============================================================
   إجابة مباشرة على سؤال المالك: "هل التطبيق يعمل بشكل طبيعي الآن؟"

   أربعة حقول فقط حسب العقد المعتمد — لا تفاصيل أحداث أمنية فردية هنا
   (مكانها owner-security لاحقًا)، ولا حقل overall_status أو
   ai_provider_status (مؤجَّلان عمدًا لغياب مصدر بيانات موثوق لهما).

   لا يستدعي أي منطق كتابة أو تعديل. GET فقط، محمي بحارس المصادقة
   المشترك في api/_lib/ownerAuth.js.
   ============================================================ */

export const config = { runtime: "edge" };

import { CONFIG } from "./_lib/config.js";
import { getSnapshot } from "./_lib/monitor.js";
import { checkGlobalDailyCap } from "./_lib/ratelimit.js";
import { guardOwnerRequest, jsonResponse } from "./_lib/ownerAuth.js";

function sumSecurityEventsToday(counts) {
  if (!counts) return 0;
  let total = 0;
  for (const key in counts) {
    total += counts[key];
  }
  return total;
}

export default async function handler(req) {
  const rejection = await guardOwnerRequest(req);
  if (rejection) return rejection;

  const snapshot = getSnapshot();
  const globalUsage = checkGlobalDailyCap(CONFIG.GLOBAL_DAILY_SOFT_CAP);

  return jsonResponse({
    requests_today: globalUsage.currentCount,
    security_events_today: sumSecurityEventsToday(snapshot ? snapshot.counts : null),
    intent_layer_enabled: CONFIG.ENABLE_INTENT_LAYER,
    last_updated: new Date().toISOString()
  }, 200);
}
