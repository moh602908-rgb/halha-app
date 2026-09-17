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
   مصدر مستقل تمامًا عن ai_requests. مفتاح dallini:activity:global:{date}،
   يُزاد عبر api/track-activity.js (نقطة نهاية عامة منفصلة، بلا صلة
   بـ ask.js).

   ملاحظة مؤجَّلة (قرار صريح، ليست خطأ): فترات اليوم الأربع
   (activity_00_06_today وأخواتها، وكذلك activity_day/night) تبقى
   كما هي — توزيع لـ ai_requests حسب الفترة، وليس توزيعًا لنشاط
   التطبيق الجديد.

   المقياس المعروض هو "طلبات/نشاط" حصرًا وليس "عدد مستخدمين" — لا
   توجد وسيلة لعدّ مستخدمين فريدين دون معرّف، وهذا مرفوض صراحةً.

   ============================================================
   إصلاح Daily/Weekly/Monthly (هذه النسخة):
   ============================================================
   المشكلة السابقة: الحقول *_week و*_month لم تكن تمثّل "الأسبوع
   الحالي" و"الشهر الحالي" فعليًا، بل كانتا نافذة متحركة (Rolling
   Window) — مجموع آخر 7 أيام وآخر 30 يومًا من تاريخ اليوم، بغضّ
   النظر عن بداية الأسبوع/الشهر التقويمي. هذا يعني تراكمًا فعليًا
   عبر حدود الأسبوع/الشهر، وهو ما لا يريده المالك.

   الإصلاح: الأسبوع والشهر يُحسبان الآن تقويميًا بتوقيت UTC —
   - الأسبوع الحالي: من السبت 00:00 UTC إلى الجمعة 23:59 UTC (بداية
     الأسبوع معتمدة صراحةً كالسبت، حسب الاتفاق).
   - الشهر الحالي: من اليوم الأول من الشهر (00:00 UTC) إلى اليوم
     الحالي ضمنًا.
   عند بداية أسبوع/شهر جديد، تُعاد حسابات النطاق تلقائيًا من نقطة
   الصفر (السبت الجديد / اليوم الأول الجديد) لأن هذا حساب وقت-قراءة
   (Read-time) على مفاتيح يومية موجودة أصلًا، وليس عدّادًا تراكميًا
   مكتوبًا — لا حاجة لأي عملية "تصفير" يدوية ولا لأي أرشيف تاريخي
   جديد ولا لأي كتابة Redis إضافية.

   لا تغيير على مفاتيح Redis، ولا على عقد الحقول المُرجَعة (نفس
   الأسماء بالضبط)، ولا على أي ملف آخر غير هذا الملف.

   Fail-open: أي فشل في نداء Redis المجمّع يُعيد كل الحقول الرقمية
   كصفر، والاستجابة تبقى 200 دائمًا — لا سقوط لطلب اللوحة أبدًا.

   GET فقط، محمي بحارس المصادقة المشترك في api/_lib/ownerAuth.js.
   ============================================================ */

export const config = { runtime: "edge" };

import { periodKeysForTodayUTC } from "./_lib/ratelimit.js";
import { monitorKeyForDate } from "./_lib/monitor.js";
import { redisPipeline } from "./_lib/redisStore.js";
import { guardOwnerRequest, jsonResponse } from "./_lib/ownerAuth.js";

const REJECTED_OR_FAILED_EVENTS = [
  "too_fast", "quota_limit", "origin_block", "validation_error",
  "method_not_allowed", "unsupported_content_type", "bad_request",
  "empty_question", "provider_error"
];

function todayKeyUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// كل مفاتيح التاريخ (YYYY-MM-DD) من start إلى end ضمنًا، بتوقيت UTC.
function dateKeysInRangeUTC(start, end) {
  const keys = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor <= last) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

// السبت (00:00 UTC) لبداية الأسبوع الحالي الذي يقع فيه "الآن" —
// الأسبوع المعتمد: السبت 00:00 UTC إلى الجمعة 23:59 UTC.
function startOfCurrentWeekUTC(now) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay(): 0 = الأحد ... 6 = السبت. المسافة بالأيام إلى آخر سبت:
  // السبت نفسه → 0، الأحد → 1، الاثنين → 2 ... الجمعة → 6.
  const daysSinceSaturday = (now.getUTCDay() + 1) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceSaturday);
  return start;
}

// اليوم الأول (00:00 UTC) من الشهر الحالي الذي يقع فيه "الآن".
function startOfCurrentMonthUTC(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function usageKeyForDate(dateStr) {
  return `dallini:usage:global:${dateStr}`;
}

// مصدر app_activity المستقل — يُزاد فقط من api/track-activity.js.
function activityKeyForDate(dateStr) {
  return `dallini:activity:global:${dateStr}`;
}

function sumHashFieldForDates(dateKeys, monitorFlatByDate, field) {
  let total = 0;
  for (const d of dateKeys) {
    const flat = monitorFlatByDate[d];
    if (!flat) continue;
    for (let i = 0; i < flat.length; i += 2) {
      if (flat[i] === field) total += parseInt(flat[i + 1], 10) || 0;
    }
  }
  return total;
}

function sumRejectedForDates(dateKeys, monitorFlatByDate) {
  let total = 0;
  for (const eventName of REJECTED_OR_FAILED_EVENTS) {
    total += sumHashFieldForDates(dateKeys, monitorFlatByDate, eventName);
  }
  return total;
}

function sumIntForDates(dateKeys, valueByDate) {
  let total = 0;
  for (const d of dateKeys) total += (valueByDate[d] || 0);
  return total;
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

  const now = new Date();
  const today = todayKeyUTC();

  const weekDateKeys = dateKeysInRangeUTC(startOfCurrentWeekUTC(now), now);
  const monthDateKeys = dateKeysInRangeUTC(startOfCurrentMonthUTC(now), now);
  const todayDateKeys = [today];

  // اتحاد كل التواريخ المطلوبة فعليًا (بلا تكرار) — قد يتقاطع نطاقا
  // الأسبوع والشهر دون أن يتطابقا بالكامل (مثلاً أول أيام الشهر قد
  // تقع ضمن أسبوع يمتد من الشهر السابق)، لذلك نجلب الاتحاد فقط.
  const allDateKeys = Array.from(new Set([...weekDateKeys, ...monthDateKeys]));

  const periodKeys = periodKeysForTodayUTC();
  const usageKeys = allDateKeys.map(usageKeyForDate);
  const monitorKeys = allDateKeys.map(monitorKeyForDate);
  const activityKeys = allDateKeys.map(activityKeyForDate);

  // نداء Upstash واحد فقط يضم كل الأوامر معًا.
  const commands = [
    ...periodKeys.map(k => ["GET", k]),
    ...usageKeys.map(k => ["GET", k]),
    ...monitorKeys.map(k => ["HGETALL", k]),
    ...activityKeys.map(k => ["GET", k])
  ];

  const result = await redisPipeline(commands);
  if (!result) return jsonResponse(buildEmptyResponse(), 200);

  const periodResults = result.slice(0, periodKeys.length);
  const usageResults = result.slice(periodKeys.length, periodKeys.length + usageKeys.length);
  const monitorResults = result.slice(
    periodKeys.length + usageKeys.length,
    periodKeys.length + usageKeys.length + monitorKeys.length
  );
  const activityResults = result.slice(periodKeys.length + usageKeys.length + monitorKeys.length);

  const p = periodResults.map(r =>
    (r && r.result !== null && r.result !== undefined) ? (parseInt(r.result, 10) || 0) : 0
  );

  // فهرسة النتائج حسب التاريخ (بدل الاعتماد على ترتيب Slice ثابت) —
  // ضرورية الآن لأن نطاقي الأسبوع والشهر لم يعودا بالضرورة متطابقين
  // في الطول أو البداية.
  const usageByDate = {};
  const activityByDate = {};
  const monitorFlatByDate = {};

  allDateKeys.forEach((d, i) => {
    const usageRaw = usageResults[i] ? usageResults[i].result : null;
    usageByDate[d] = usageRaw === null || usageRaw === undefined ? 0 : (parseInt(usageRaw, 10) || 0);

    const activityRaw = activityResults[i] ? activityResults[i].result : null;
    activityByDate[d] = activityRaw === null || activityRaw === undefined ? 0 : (parseInt(activityRaw, 10) || 0);

    const monitorItem = monitorResults[i];
    monitorFlatByDate[d] = monitorItem && Array.isArray(monitorItem.result) ? monitorItem.result : null;
  });

  return jsonResponse({
    activity_00_06_today: p[0],
    activity_06_12_today: p[1],
    activity_12_18_today: p[2],
    activity_18_24_today: p[3],
    activity_night_today: p[0] + p[3],
    activity_day_today: p[1] + p[2],

    ai_requests_today: sumIntForDates(todayDateKeys, usageByDate),
    ai_requests_week: sumIntForDates(weekDateKeys, usageByDate),
    ai_requests_month: sumIntForDates(monthDateKeys, usageByDate),

    app_activity_today: sumIntForDates(todayDateKeys, activityByDate),
    app_activity_week: sumIntForDates(weekDateKeys, activityByDate),
    app_activity_month: sumIntForDates(monthDateKeys, activityByDate),

    rejected_or_failed_week: sumRejectedForDates(weekDateKeys, monitorFlatByDate),
    rejected_or_failed_month: sumRejectedForDates(monthDateKeys, monitorFlatByDate),

    provider_errors_today: sumHashFieldForDates(todayDateKeys, monitorFlatByDate, "provider_error"),
    provider_errors_week: sumHashFieldForDates(weekDateKeys, monitorFlatByDate, "provider_error"),
    provider_errors_month: sumHashFieldForDates(monthDateKeys, monitorFlatByDate, "provider_error"),

    injection_attempts_today: sumHashFieldForDates(todayDateKeys, monitorFlatByDate, "intent_injection_block"),
    injection_attempts_week: sumHashFieldForDates(weekDateKeys, monitorFlatByDate, "intent_injection_block"),
    injection_attempts_month: sumHashFieldForDates(monthDateKeys, monitorFlatByDate, "intent_injection_block"),

    protection_bypass_today: sumHashFieldForDates(todayDateKeys, monitorFlatByDate, "origin_block"),
    protection_bypass_week: sumHashFieldForDates(weekDateKeys, monitorFlatByDate, "origin_block"),
    protection_bypass_month: sumHashFieldForDates(monthDateKeys, monitorFlatByDate, "origin_block"),

    abnormal_requests_today: sumHashFieldForDates(todayDateKeys, monitorFlatByDate, "reject_flood_detected"),
    abnormal_requests_week: sumHashFieldForDates(weekDateKeys, monitorFlatByDate, "reject_flood_detected"),
    abnormal_requests_month: sumHashFieldForDates(monthDateKeys, monitorFlatByDate, "reject_flood_detected"),

    owner_login_failed_today: sumHashFieldForDates(todayDateKeys, monitorFlatByDate, "owner_auth_failed"),
    owner_login_failed_week: sumHashFieldForDates(weekDateKeys, monitorFlatByDate, "owner_auth_failed"),
    owner_login_failed_month: sumHashFieldForDates(monthDateKeys, monitorFlatByDate, "owner_auth_failed"),

    last_updated: new Date().toISOString()
  }, 200);
}
