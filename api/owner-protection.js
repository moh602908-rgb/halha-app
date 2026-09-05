/* ============================================================
   /api/owner-protection — حالة الحماية العامة للنظام (Owner Dashboard)
   ============================================================
   نطاق النظام بالكامل (protection_scope: "system-wide") — لا علاقة
   له بحظر أفراد أو أجهزة؛ لا يوجد نظام حظر كهذا في المشروع أصلاً،
   واللوحة لا تعرض ولا تحتوي أي قائمة "محظورين".

   كل الحقول إما قيم ثابتة أو تعكس حقيقة الحماية البنيوية الحالية
   (فحص Origin + HMAC لكوكي الاستخدام + Rate-Limiting) المفروضة أصلاً
   في api/ask.js وapi/_lib/ratelimit.js — هذا الملف لا يستدعي
   getSnapshot() ولا checkGlobalDailyCap() ولا أي منطق مراقبة، ولا
   يقرأ أو يكتب أي حالة.

   قراءة فقط بالكامل: GET فقط، صفر أي إمكانية تعديل أو كتابة، صفر أي
   endpoint مقابل لتنفيذ إجراء فعلي. محمية بنفس حارس المصادقة المشترك
   في api/_lib/ownerAuth.js.
   ============================================================ */

export const config = { runtime: "edge" };

import { guardOwnerRequest, jsonResponse } from "./_lib/ownerAuth.js";

export default async function handler(req) {
  const rejection = await guardOwnerRequest(req);
  if (rejection) return rejection;

  return jsonResponse({
    protection_scope: "system-wide",
    base_protection_enabled: true,
    auto_block_enabled: false,
    calm_mode_enabled: false,
    strict_mode_enabled: false,
    last_updated: new Date().toISOString()
  }, 200);
}
