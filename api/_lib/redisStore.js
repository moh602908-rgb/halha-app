/* ============================================================
   api/_lib/redisStore.js — طبقة وصول موحّدة إلى Upstash Redis
   ============================================================
   يعزل كل تفاصيل الاتصال بـ Upstash (REST API عبر fetch) في مكان واحد.
   سياسة الفشل: Fail-open دائمًا — أي خطأ شبكة أو استجابة غير ناجحة
   يُسجَّل في console.warn فقط، ولا يُرمى كاستثناء يوقف الطلب.
   ============================================================ */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function isConfigured() {
  return Boolean(UPSTASH_URL && UPSTASH_TOKEN);
}

async function callUpstash(commands) {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(commands)
    });
    if (!res.ok) {
      console.warn("[dallini-redis] http_error", res.status);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn("[dallini-redis] fetch_error", String(e && e.message ? e.message : e).slice(0, 200));
    return null;
  }
}

// يزيد عدّادًا (INCR) ويجدّد TTL في نفس الاستدعاء — فشل صامت.
export async function redisIncrWithExpire(key, ttlSeconds) {
  const result = await callUpstash([["INCR", key], ["EXPIRE", key, ttlSeconds]]);
  return result ? (result?.[0]?.result ?? null) : null;
}

// يقرأ عدّادًا؛ 0 إن لم يوجد المفتاح، null فقط عند فشل الاتصال (Fail-open).
export async function redisGetInt(key) {
  const result = await callUpstash([["GET", key]]);
  if (!result) return null;
  const raw = result?.[0]?.result;
  return raw === null || raw === undefined ? 0 : parseInt(raw, 10);
}

// يزيد حقلًا داخل Hash (HINCRBY) ويجدّد TTL على المفتاح كاملًا.
export async function redisHIncrByWithExpire(key, field, amount, ttlSeconds) {
  const result = await callUpstash([["HINCRBY", key, field, amount], ["EXPIRE", key, ttlSeconds]]);
  return result ? (result?.[0]?.result ?? null) : null;
}

// يقرأ كل حقول Hash — لاستخدام owner-usage/owner-security لاحقًا.
export async function redisHGetAll(key) {
  const result = await callUpstash([["HGETALL", key]]);
  return result ? (result?.[0]?.result ?? null) : null;
}

/* ============================================================
   إضافة مستقلة — قراءة مجمّعة لعدّة مفاتيح في نداء HTTP واحد
   ============================================================
   لا تعديل على أي من الدوال أعلاه ولا على callUpstash نفسها ولا
   إعادة ترتيب لأي كود موجود. الهدف الوحيد: تمكين owner-insights.js
   من تجميع عشرات الأوامر في نداء Upstash واحد فقط عند فتح لوحة
   المالك حصرًا. نفس سياسة Fail-open: null عند فشل الاتصال.
   ============================================================ */
export async function redisPipeline(commands) {
  return callUpstash(commands);
}
