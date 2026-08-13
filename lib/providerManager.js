/* ============================================================
   lib/providerManager.js — Provider Manager (طبقة القرار)
   ============================================================
   الهدف: هذا الملف لا يعرف أي تفاصيل عن أي مزوّد ذكاء اصطناعي (لا Gemini
   ولا غيره) — تلك التفاصيل تبقى بالكامل في lib/providers.js كما هي.

   هذا الملف مسؤول فقط عن قرار واحد: "بأي ترتيب نجرّب المحركات، ومتى
   نتوقف عن المحاولة؟" — أي طبقة تنسيق فوق providers.js، وليست بديلاً
   عنه.

   السلوك الافتراضي (بدون أي تغيير في Vercel): PROVIDER_CHAIN تحتوي
   محركاً واحداً فقط (نفس AI_PROVIDER الحالي)، وبالتالي هذا الملف يتصرف
   تماماً كاستدعاء مباشر لـ callAIProvider — صفر فرق سلوكي عن الوضع
   الحالي، إلى أن يُضاف محرك ثانٍ فعلياً في CONFIG.PROVIDER_CHAIN مستقبلاً.

   لإضافة محرك احتياطي مستقبلاً (خطوة منفصلة لاحقة، وليست جزءاً من هذا
   التغيير): يكفي تعديل CONFIG.PROVIDER_CHAIN في lib/config.js لتحتوي
   أكثر من اسم مسجّل في lib/providers.js. لا حاجة لأي تعديل هنا ولا في
   api/ask.js.
   ============================================================ */

import { CONFIG } from "./config.js";
import { callAIProvider } from "./providers.js";

export async function resolveAndCall(params) {
  const chain = Array.isArray(CONFIG.PROVIDER_CHAIN) && CONFIG.PROVIDER_CHAIN.length
    ? CONFIG.PROVIDER_CHAIN
    : [CONFIG.ACTIVE_PROVIDER]; // شبكة أمان: لو كانت القائمة فارغة لأي سبب، نُعيد نفس السلوك القديم تماماً

  let lastError;

  for (let i = 0; i < chain.length; i++) {
    const providerName = chain[i];
    try {
      return await callAIProvider(providerName, params);
    } catch (e) {
      lastError = e;
      const isLastInChain = i === chain.length - 1;
      const canRetry = e && e.retryable === true;
      // نتوقف فوراً إذا: كان هذا آخر محرك في القائمة، أو كان الخطأ نهائياً
      // (retryable === false) ولا فائدة تقنية من تجربة محرك آخر بنفس المشكلة
      // الجوهرية (مثال: مفتاح غير صالح غالبًا لن يُصلحه تغيير المحرك).
      if (isLastInChain || !canRetry) {
        throw lastError;
      }
      // خلاف ذلك: خطأ مؤقت (retryable === true) ويوجد محرك تالٍ — نجرّبه.
    }
  }

  // لن يُصل هذا السطر عملياً (الحلقة أعلاه إما تُرجع أو ترمي)، موجود فقط
  // كحارس أمان إضافي يمنع أي سلوك غير معرّف.
  throw lastError || new Error("provider_manager: no provider available");
}
