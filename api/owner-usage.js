/* ============================================================
   /api/owner-usage — الاستهلاك والسقوف (Owner Dashboard)
   ============================================================
   خمسة حقول فقط حسب العقد المعتمد. لا hourly_distribution ولا
   projected_to_exhaust_today في هذا الإصدار (مؤجَّلان لغياب مصدر
   بيانات بالساعة).

   كل الحقول تُقرأ من دوال موجودة أصلًا وتُستخدم بنفس الشكل في
   owner-status.js وowner-overview.js — لا تعديل على monitor.js أو
   ratelimit.js أو config.js.

   GET فقط، محمي بحارس المصادقة المشترك في api/_lib/ownerAuth.js.

   تحديث — إصلاح ما بعد نقل العدّادات إلى Upstash Redis:
   getSnapshot() وcheckGlobalDailyCap() أصبحتا async (تتصلان بـ Redis
   عبر redisStore.js)، فأُضيف await أمام استدعائهما هنا. لا تغيير في
   منطق الحماية أو الحسابات أو مصدر البيانات — Redis يبقى مصدر
   الحقيقة كما هو مصمَّم. التعديل الوحيد الإضافي: تقريب النسبة المئوية
   لرقم صحيح بدل رقم عشري بمنزلة واحدة، لعرض أوضح في لوحة المالك.
   ============================================================ */

export const config = { runtime: "edge" };

import { CONFIG } from "./_lib/config.js";
import { getSnapshot } from "./_lib/monitor.js";
import { checkGlobalDailyCap } from "./_lib/ratelimit.js";
import { guardOwnerRequest, jsonResponse } from "./_lib/ownerAuth.js";

// معالجة آمنة: إن كان daily_quota_limit غير رقم صالح أو صفر أو أقل
// (حالة إعداد غير متوقعة)، نُرجع 0 بدل NaN أو Infinity، دون أي رمي
// استثناء يُسقط الطلب.
function safeUsagePercentage(count, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  if (!Number.isFinite(count) || count < 0) return 0;
  const pct = (count / limit) * 100;
  return Math.round(pct); // رقم صحيح للعرض في لوحة المالك — بلا دقة عشرية غير مفيدة
}

export default async function handler(req) {
  const rejection = await guardOwnerRequest(req);
  if (rejection) return rejection;

  const snapshot = await getSnapshot();
  const globalUsage = await checkGlobalDailyCap(CONFIG.GLOBAL_DAILY_SOFT_CAP);
  const dailyQuotaLimit = CONFIG.GLOBAL_DAILY_SOFT_CAP;

  return jsonResponse({
    requests_today: globalUsage.currentCount,
    daily_quota_limit: dailyQuotaLimit,
    quota_usage_percentage: safeUsagePercentage(globalUsage.currentCount, dailyQuotaLimit),
    quota_limit_hits_today: snapshot && snapshot.counts ? snapshot.counts.quota_limit : 0,
    last_updated: new Date().toISOString()
  }, 200);
}
