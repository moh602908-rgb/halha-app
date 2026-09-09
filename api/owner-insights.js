/* ============================================================
   /api/owner-insights — رؤية المالك: النشاط والأمان (Owner Dashboard)
   ============================================================
   بطاقة سادسة جديدة، بلا أي تعديل على العقود الخمسة القائمة ولا
   على ask.js أو prompt.js أو نظام اللهجات أو ownerAuth.js.

   مبدأ التصميم: قراءة مجمّعة فقط لكل ما هو أسبوعي/شهري/أمني/نشاط
   عام — نداء Upstash واحد (pipeline) يضم كل الأوامر معًا. الاستثناء
   الوحيد: فترات اليوم الأربع، تُكتب فعليًا في ratelimit.js (موثَّق
   هناك) لأنها الشيء الوحيد غير القابل للاشتقاق لاحقًا.

   نشاط التطبيق (app_activity_*):
   لا توجد اليوم أي إشارة "فتح تطبيق" منفصلة عن "سؤال" — التطبيق لا
   يفعل شيئًا آخر بعد. لذلك يُشتق app_activity_* حاليًا من نفس مصدر
   ai_requests_* (نفس القيمة تمامًا، بقرار معماري صريح، لا كتابة
   Redis إضافية). عند توفر إشارة نشاط عامة مستقلة لاحقًا (خصوصًا مع
   Android)، نقطة التوسعة الوحيدة هي هذا الملف: إضافة مصدر ثانٍ إلى
   دالة computeAppActivity أدناه وجمعه — بلا أي تعديل على بنية
   اللوحة أو الملفات الأخرى.

   المقياس المعروض هو "طلبات/نشاط" حصرًا وليس "عدد مستخدمين" — لا
   توجد وسيلة لعدّ مستخدمين فريدين دون معرّف، وهذا مرفوض صراحةً.

   Fail-open: أي فشل في نداء Redis المجمّع يُعيد كل الحقول الرقمية
   كصفر، والاستجابة تبقى 200 دائمًا — لا سقوط لطلب اللوحة أبدًا.

   GET فقط، محمي بحارس المصادقة المشترك في api/_lib/ownerAuth.js.
   ============================================================ */

export const config = { runtime: "edge" };

import { periodKeysForTodayUTC } from "./_lib/ratelimit.js";
import { monitorKeyForDate } from "./_lib/monitor.js";
import { redisPipeline } from "./_lib/redisStore.js";
import { guardOwnerRequest, jsonResponse } from "./_lib/ownerAuth.js";

const MONTH_DAYS = 30;
const WEEK_DAYS = 7;

const REJECTED_OR_FAILED_EVENTS = [
  "too_fast", "quota_limit", "origin_block", "validation_error",
  "method_not_allowed", "unsupported_content_type", "bad_request",
  "empty_question", "provider_error"
];

function lastNDateKeysUTC(n) {
  const dates = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function usageKeyForDate(dateStr) {
  return `dallini:usage:global:${dateStr}`;
}

function sumHashField(hashResults, field) {
  let total = 0;
  for (const item of hashResults) {
    const flat = item && Array.isArray(item.result) ? item.result : null;
    if (!flat) continue;
    for (let i = 0; i < flat.length; i += 2) {
      if (flat[i] === field) total += parseInt(flat[i + 1], 10) || 0;
    }
  }
  return total;
}

function sumRejected(hashResults) {
  let total = 0;
  for (const eventName of REJECTED_OR_FAILED_EVENTS) total += sumHashField(hashResults, eventName);
  return total;
}

function sumGetResults(getResults) {
  let total = 0;
  for (const item of getResults) {
    const raw = item ? item.result : null;
    total += raw === null || raw === undefined ? 0 : (parseInt(raw, 10) || 0);
  }
  return total;
}

// نقطة التوسعة الوحيدة لنشاط التطبيق العام مستقبلاً (مثال: Android):
// حاليًا مصدر واحد فقط (نفس أرقام الأسئلة)، لأن لا إشارة أخرى متاحة.
function computeAppActivity(aiRequestsValue) {
  return aiRequestsValue; // TODO مستقبلاً: + مصدر Android عند توفره
}

function buildEmptyResponse() {
  return {
    activity_00_06_today: 0, activity_06_12_today: 0, activity_12_18_today: 0, activity_18_24_today: 0,
    activity_night_today: 0, activity_day_today: 0,
    ai_requests_today: 0, ai_requests_week: 0, ai_requests_month: 0,
    app_activity_today: 0, app_activity_week: 0, app_activity_month: 0,
    rejected_or_failed_week: 0, rejected_or_failed_month: 0,
    provider_errors_today: 0, provider_errors_week: 0, provider_errors_month: 0,
    injection_attempts_today: 0, injection_attempts_week: 0, injection_attempts_month: 0,
    protection_bypass_today: 0, protection_bypass_week: 0, protection_bypass_month: 0,
    abnormal_requests_today: 0, abnormal_requests_week: 0, abnormal_requests_month: 0,
    owner_login_failed_today: 0, owner_login_failed_week: 0, owner_login_failed_month: 0,
    last_updated: new Date().toISOString()
  };
}

export default async function handler(req) {
  const rejection = await guardOwnerRequest(req);
  if (rejection) return rejection;

  const dateKeys = lastNDateKeysUTC(MONTH_DAYS);
  const periodKeys = periodKeysForTodayUTC();
  const monitorKeys = dateKeys.map(monitorKeyForDate);
  const usageKeys = dateKeys.map(usageKeyForDate);

  // نداء Upstash واحد فقط يضم كل الأوامر معًا (4 + 30 + 30 = 64 أمرًا).
  const commands = [
    ...periodKeys.map(k => ["GET", k]),
    ...usageKeys.map(k => ["GET", k]),
    ...monitorKeys.map(k => ["HGETALL", k])
  ];

  const result = await redisPipeline(commands);
  if (!result) return jsonResponse(buildEmptyResponse(), 200);

  const periodResults = result.slice(0, periodKeys.length);
  const usageResultsAll = result.slice(periodKeys.length, periodKeys.length + usageKeys.length);
  const monitorResultsAll = result.slice(periodKeys.length + usageKeys.length);

  const usageResultsWeek = usageResultsAll.slice(0, WEEK_DAYS);
  const monitorResultsWeek = monitorResultsAll.slice(0, WEEK_DAYS);
  const monitorResultsToday = monitorResultsAll.slice(0, 1);

  const p = periodResults.map(r =>
    (r && r.result !== null && r.result !== undefined) ? (parseInt(r.result, 10) || 0) : 0
  );

  const aiToday = sumGetResults(usageResultsAll.slice(0, 1));
  const aiWeek = sumGetResults(usageResultsWeek);
  const aiMonth = sumGetResults(usageResultsAll);

  return jsonResponse({
    activity_00_06_today: p[0],
    activity_06_12_today: p[1],
    activity_12_18_today: p[2],
    activity_18_24_today: p[3],
    activity_night_today: p[0] + p[3],
    activity_day_today: p[1] + p[2],

    ai_requests_today: aiToday,
    ai_requests_week: aiWeek,
    ai_requests_month: aiMonth,

    app_activity_today: computeAppActivity(aiToday),
    app_activity_week: computeAppActivity(aiWeek),
    app_activity_month: computeAppActivity(aiMonth),

    rejected_or_failed_week: sumRejected(monitorResultsWeek),
    rejected_or_failed_month: sumRejected(monitorResultsAll),

    provider_errors_today: sumHashField(monitorResultsToday, "provider_error"),
    provider_errors_week: sumHashField(monitorResultsWeek, "provider_error"),
    provider_errors_month: sumHashField(monitorResultsAll, "provider_error"),

    injection_attempts_today: sumHashField(monitorResultsToday, "intent_injection_block"),
    injection_attempts_week: sumHashField(monitorResultsWeek, "intent_injection_block"),
    injection_attempts_month: sumHashField(monitorResultsAll, "intent_injection_block"),

    protection_bypass_today: sumHashField(monitorResultsToday, "origin_block"),
    protection_bypass_week: sumHashField(monitorResultsWeek, "origin_block"),
    protection_bypass_month: sumHashField(monitorResultsAll, "origin_block"),

    abnormal_requests_today: sumHashField(monitorResultsToday, "reject_flood_detected"),
    abnormal_requests_week: sumHashField(monitorResultsWeek, "reject_flood_detected"),
    abnormal_requests_month: sumHashField(monitorResultsAll, "reject_flood_detected"),

    owner_login_failed_today: sumHashField(monitorResultsToday, "owner_auth_failed"),
    owner_login_failed_week: sumHashField(monitorResultsWeek, "owner_auth_failed"),
    owner_login_failed_month: sumHashField(monitorResultsAll, "owner_auth_failed"),

    last_updated: new Date().toISOString()
  }, 200);
}
