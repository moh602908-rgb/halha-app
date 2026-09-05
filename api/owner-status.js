/* ============================================================
   /api/owner-status — نقطة قراءة فقط خاصة بالمالك (Owner Dashboard)
   ============================================================
   معزولة تمامًا عن /api/ask ومسار المستخدم العادي:
   - لا تستورد ratelimit.js الخاص بكوكيز المستخدمين (قراءة عدّاد
     السقف اليومي العام فقط، وهو رقم مجمّع عام لا صلة له بأي كوكي
     أو مستخدم فردي).
   - لا تستورد intent.js ولا providers.js ولا providerManager.js
     ولا prompt.js — لا علاقة لها بمسار توليد الإجابات إطلاقًا.
   - مفتاح مصادقة مستقل كليًا (OWNER_ACCESS_KEY) عن AI_API_KEY
     وRATE_LIMIT_SECRET — تسرّب أي منهما لا يكشف الآخر.

   الصلاحيات: GET فقط، قراءة فقط، صفر أي إمكانية تعديل أو كتابة.

   البيانات المُرجعة: عدّادات مجمّعة (Enum مغلق من monitor.js) وحالة
   إعداد عامة (اسم المزوّد/النموذج، هل طبقة Intent مفعّلة، السقف
   اليومي العام مقابل الاستهلاك الحالي) — لا شيء آخر. لا IP، لا
   User-Agent، لا نص سؤال، لا أي معرّف فردي في أي مكان من هذا الملف.

   ------------------------------------------------------------
   تحديث Owner Dashboard — الخطوة 1:
   ------------------------------------------------------------
   منطق المصادقة (HMAC، sha256، المقارنة بزمن ثابت، رد الرفض الموحّد،
   سلوك GET/405، حارس محاولات المصادقة) انتقل بالكامل إلى الوحدة
   المشتركة api/_lib/ownerAuth.js دون أي تغيير في منطقه الداخلي، لإعادة
   استخدامه من كل نقاط Owner Dashboard القادمة. التغيير الأمني الوحيد
   المقصود المترتب على هذا النقل: حارس محاولات المصادقة أصبح مشتركًا
   بين كل نقاط المالك (موثَّق بالتفصيل في ownerAuth.js نفسه) — لا تغيير
   آخر في شكل الاستجابة أو منطق البيانات المُرجعة من هذا الملف.
   ============================================================ */

export const config = { runtime: "edge" };

import { CONFIG } from "./_lib/config.js";
import { getSnapshot } from "./_lib/monitor.js";
import { checkGlobalDailyCap } from "./_lib/ratelimit.js";
import { guardOwnerRequest, jsonResponse } from "./_lib/ownerAuth.js";

export default async function handler(req) {
  const rejection = await guardOwnerRequest(req);
  if (rejection) return rejection;

  const snapshot = getSnapshot();
  const globalUsage = checkGlobalDailyCap(CONFIG.GLOBAL_DAILY_SOFT_CAP);

  return jsonResponse({
    date: snapshot ? snapshot.date : null,
    events: snapshot ? snapshot.counts : null,
    window: snapshot ? snapshot.window : null,
    config: {
      enableIntentLayer: CONFIG.ENABLE_INTENT_LAYER,
      activeProvider: CONFIG.ACTIVE_PROVIDER,
      defaultModel: CONFIG.DEFAULT_MODEL
    },
    usage: {
      dailyGlobalCount: globalUsage.currentCount,
      dailyGlobalCap: CONFIG.GLOBAL_DAILY_SOFT_CAP,
      withinCap: globalUsage.withinCap
    }
  }, 200);
}
