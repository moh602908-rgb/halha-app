/* ============================================================
   /api/track-activity — عدّاد نشاط التطبيق (App Activity)
   ============================================================
   نقطة نهاية عامة خفيفة، مستقلة تمامًا عن مسار الأسئلة (ask.js).
   الهدف الوحيد: زيادة عدّاد "نشاط التطبيق الحقيقي" — بمعزل كامل
   عن عدد طلبات الذكاء الاصطناعي (ai_requests) — حتى لا تُقاس زيارة
   أو استخدام التطبيق بعدد الأسئلة المطروحة.

   لا مصادقة (owner key) هنا: ليس مسارًا حساسًا — عدّاد يومي مجمّع
   فقط، بلا أي معرّف فردي أو بيانات شخصية (يطابق مبدأ الخصوصية
   المعتمد في كل الملفات الأخرى).

   POST فقط (لا GET) عمدًا: حسب sw.js الحالي، أي طلب غير GET
   يتجاهله الـ Service Worker تمامًا ("لا تخزين ولا اعتراض") — فلا
   داعٍ لأي تعديل إضافي على sw.js لاستثناء هذا المسار.

   Fail-open: أي فشل في الاتصال بـ Redis (المنطق بالكامل داخل
   redisStore.js) لا يُرجع خطأ للمتصفح — الاستجابة تبقى ناجحة دائمًا.

   نقطة التوسعة لـ Android لاحقًا: نفس هذه النقطة (POST بلا Body)
   تُستدعى من التطبيق عند فتح/استخدام حقيقي فتزيد نفس المفتاح —
   بلا أي تعديل على owner-insights.js أو لوحة المالك.
   ============================================================ */

export const config = { runtime: "edge" };

import { redisIncrWithExpire } from "./_lib/redisStore.js";
import { todayKeyUTC } from "./_lib/ratelimit.js";

const ACTIVITY_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 يومًا — نفس سياسة ai_requests

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const key = `dallini:activity:global:${todayKeyUTC()}`;
  await redisIncrWithExpire(key, ACTIVITY_TTL_SECONDS); // فشل صامت (Fail-open) داخل الدالة نفسها

  return new Response(null, { status: 204 });
}
