/* ============================================================
   api/_lib/intent.js — طبقة تصنيف النوايا (العقل الذكي الآمن)
   ============================================================
   Phase 12.3 — يطبّق حرفيًا العقد المعتمد في Phase 12.2.4 وقرارات
   المراجعة اللاحقة. هذا الملف مستقل تمامًا؛ لا يُعدَّل بسببه أي
   ملف آخر (ask.js، prompt.js، providerManager.js...).

   القيود المعمارية الصارمة (Non-negotiable):
   1) Pure function واحدة مُصدَّرة: classifyIntent(question).
      نفس المُدخل → نفس المُخرَج دائمًا، بلا حالة داخلية محفوظة.
   2) متزامن بالكامل: لا await، لا شبكة، لا أي استدعاء AI.
   3) لا أي أثر جانبي: لا كتابة، لا تسجيل. هذا الملف لا يستورد
      monitor.js إطلاقًا — التسجيل مسؤولية المستدعي (ask.js).
   4) المدخل الوحيد المفحوص: question. لا history، لا guides
      القادمة من العميل (body?.guides) — عدم الثقة بمدخلات العميل.
   5) القاعدة العامة الملزمة: لا كشف يعتمد على كلمة منفردة — كل
      تصنيف مبني على تركيب (نمط + سياق).
   6) أي خطأ داخلي غير متوقع → يُعاد "unknown" (الحياد الآمن)،
      وليس "injection_attempt" أبدًا. فشل الكود ليس دليل نية.

   مصدر البيانات:
   guides-index.json يُستورد استيرادًا ثابتًا (لا fetch وقت التشغيل)
   لأنه يُضمَّن ضمن حزمة الخادم وقت النشر. يُستخدم حصريًا لدعم فئة
   "practical_clear"؛ الحقول التوثيقية فيه (totalGuides, generatedAt
   ...) تُتجاهَل تمامًا من منطق التصنيف.

   ترتيب الفحص الإلزامي (أول تطابق يفوز، لا استمرار بعده):
   1. injection_attempt
   2. sensitive
   3. practical_clear
   4. practical_vague
   5. general_question
   6. out_of_scope
   7. unknown  (افتراضي)
   ============================================================ */

import guidesIndexRaw from "./guides-index.js";

// ================================================================
// دوال وثوابت مساعدة أساسية — يجب أن تُعرَّف هنا، قبل أي كود يستخدمها
// عند تحميل الوحدة (module load)، وليس فقط قبل استخدامها داخل
// classifyIntent(). دوال JS (function declarations) تُرفَع (hoisted)،
// لكن الثوابت (const) لا تُرفَع بنفس الطريقة — استخدامها قبل سطر
// تعريفها الفعلي يسبب خطأ (Temporal Dead Zone) حتى داخل دالة مرفوعة.
// ترتيب هذا الملف يراعي ذلك عمدًا بعد أن كشف الاختبار الفعلي هذا الخطأ.
// ================================================================

// تطبيع نص عربي مبسّط ومستقل تمامًا (لا استيراد من app.js، فهو
// سكربت عادٍ من جهة العميل لا وحدة ESM يمكن استيرادها من الخادم).
function normalizeArabic(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/[\u064B-\u065F\u0670]/g, "") // إزالة التشكيل
    .replace(/\u0640/g, "") // إزالة التطويل (ـ)
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\S\r\n]+/g, " ") // مسافات متعددة إلى مسافة واحدة
    .trim()
    .toLowerCase();
}

// كلمات وظيفية شائعة (حروف جر/عطف/ضمائر) لا تحمل أي دلالة على مجال أو
// دليل بعينه — استبعادها ضروري لمنع تطابق practical_clear الزائف
// (مثال مكتشف بالاختبار الفعلي: "عندي مشكلة في البيت" كانت تتطابق
// خطأً بسبب اشتراك حرف الجر "في" مع دليل غير ذي صلة، رغم أن "القاعدة
// العامة الملزمة" تنص أصلاً على أن لا كشف يعتمد على كلمة منفردة
// عديمة الدلالة).
const STOPWORDS = new Set([
  "في", "من", "الي", "إلى", "على", "عن", "او", "أو", "و", "ان", "أن",
  "لا", "ما", "هل", "مع", "كل", "هذا", "هذه", "ذلك", "التي", "الذي",
  "لي", "له", "لها", "كان", "اذا", "إذا", "حتى", "ثم", "بل", "ايضا",
  "بعد", "قبل", "عندي", "عندك", "عنده"
]);

function tokenize(normalizedStr) {
  if (!normalizedStr) return [];
  return normalizedStr
    .split(/[\s،,.\-_/\\؛:؟!?()]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function containsAny(normalizedText, phrases) {
  return phrases.some((p) => normalizedText.includes(p));
}

// --------------------------------------------------------------
// تحميل آمن لفهرس الأدلة عند إقلاع الوحدة (وليس عند كل استدعاء).
// إن كانت البنية غير متوقعة لأي سبب، نتحول لمصفوفة فارغة بصمت —
// النتيجة العملية: فئة practical_clear لا تتحقق أبدًا (تسقط
// المدخلات تلقائيًا للفئات التالية في الترتيب)، بلا أي انهيار.
// --------------------------------------------------------------
let GUIDE_ENTRIES = [];
try {
  if (guidesIndexRaw && Array.isArray(guidesIndexRaw.guides)) {
    GUIDE_ENTRIES = guidesIndexRaw.guides
      .filter(
        (g) =>
          g &&
          typeof g.domainName === "string" &&
          typeof g.guideTitle === "string" &&
          g.domainName.trim() &&
          g.guideTitle.trim()
      )
      .map((g) => ({
        domainName: g.domainName.trim(),
        guideTitle: g.guideTitle.trim()
      }));
  }
} catch {
  GUIDE_ENTRIES = [];
}

// بناء فهرس مطبَّع مرة واحدة فقط (وليس في كل استدعاء لـ classifyIntent)
// لتفادي إعادة التطبيع لـ168 عنصرًا مع كل سؤال.
let GUIDE_ENTRIES_NORMALIZED = [];
try {
  GUIDE_ENTRIES_NORMALIZED = GUIDE_ENTRIES.map((g) => {
    const normalizedText = normalizeArabic(`${g.domainName} ${g.guideTitle}`);
    return {
      guideTitleNormalized: normalizeArabic(g.guideTitle),
      normalizedText,
      tokens: new Set(tokenize(normalizedText))
    };
  });
} catch {
  GUIDE_ENTRIES_NORMALIZED = [];
}

// ================================================================
// 1) injection_attempt
// تركيب: (فعل تغيير/تجاوز) + (هدف حساس) — يجب توفر الاثنين معًا.
// ================================================================
const INJECTION_ACTION_PATTERNS = [
  "تجاهل",
  "انس",
  "انسي",
  "تجاوز",
  "تجاوزي",
  "اظهر",
  "اكشف",
  "اعطني",
  "اطلعني علي",
  "تصرف كانك",
  "تظاهر انك"
];
const INJECTION_TARGET_PATTERNS = [
  "تعليماتك",
  "التعليمات",
  "القواعد",
  "قواعدك",
  "النظام",
  "نظامك",
  "system prompt",
  "البرومبت",
  "برومبت",
  "بدون قيود",
  "بدون قواعد",
  "دون قيود",
  "دون قواعد"
];

function isInjectionAttempt(normalizedText) {
  const hasAction = containsAny(normalizedText, INJECTION_ACTION_PATTERNS);
  const hasTarget = containsAny(normalizedText, INJECTION_TARGET_PATTERNS);
  return hasAction && hasTarget;
}

// ================================================================
// 2) sensitive
// تركيب من ثلاثة عناصر: سياق شخصي + مؤشر حساس (طبي/قانوني/عاطفي)
// ================================================================
const PERSONAL_CONTEXT_PATTERNS = [
  "عندي",
  "اعاني",
  "اشعر",
  "حاسس",
  "صار لي",
  "من ساعتين",
  "من يومين",
  "من اسبوع",
  "منذ ساعتين",
  "منذ يومين"
];
const MEDICAL_ACUTE_PATTERNS = [
  "الم شديد",
  "الم حاد",
  "نزيف",
  "لا استطيع التنفس",
  "فقدان وعي",
  "اغمي علي"
];
const LEGAL_PERSONAL_PATTERNS = [
  "قضيه",
  "دعوي",
  "نزاع مع",
  "رفعوا علي",
  "رفعت علي",
  "محامي"
];
const EMOTIONAL_ACUTE_PATTERNS = [
  "يأس",
  "اذي نفسي",
  "اريد ان اوذي نفسي",
  "لا اطيق الحياه",
  "فقدت الامل",
  // صيغ المصدر/الاسم لنفس المعنى أعلاه — أُضيفت بعد أن كشف الاختبار
  // الفعلي أن "إيذاء نفسي" (مصدر) لا يطابق "اذي نفسي" (فعل) حرفيًا
  // رغم قرب المعنى تمامًا.
  "ايذاء نفسي",
  "ايذاء لنفسي",
  "اذيه نفسي"
];

function isSensitive(normalizedText) {
  const hasPersonalContext = containsAny(normalizedText, PERSONAL_CONTEXT_PATTERNS);
  const hasMedical = containsAny(normalizedText, MEDICAL_ACUTE_PATTERNS);
  const hasLegal = containsAny(normalizedText, LEGAL_PERSONAL_PATTERNS);
  const hasEmotional = containsAny(normalizedText, EMOTIONAL_ACUTE_PATTERNS);
  const hasSensitiveMarker = hasMedical || hasLegal || hasEmotional;
  // الحالات العاطفية الحادة قد لا تحتاج سياقًا شخصيًا صريحًا إضافيًا
  // (العبارة نفسها شخصية بطبيعتها)، أما الطبي والقانوني فيتطلبان
  // سياقًا شخصيًا واضحًا معهما تفاديًا لتصنيف أسئلة عامة عن الطب
  // أو القانون كحالة حساسة شخصية.
  if (hasEmotional) return true;
  return hasSensitiveMarker && hasPersonalContext;
}

// ================================================================
// 3) practical_clear
// تطابق (لا كلمة منفردة) مع domainName/guideTitle من guides-index.json
// ================================================================
const MIN_TOKEN_OVERLAP = 2;

// أنماط أسئلة تعريفية عامة ("ما هو X؟") — لا يجب أن يكفي فيها اشتراك
// كلمتين عامتين مع عنوان دليل لاعتبارها "practical_clear"، لأن السؤال
// معرفي بطبيعته لا طلب مساعدة بمشكلة عملية. هذا الاستثناء يخص فقط
// التطابق الضعيف (تقاطع الرموز)؛ التطابق القوي (عنوان الدليل كاملاً
// كسلسلة متصلة داخل السؤال) يبقى فعالاً دائمًا بلا استثناء، لأنه دليل
// كافٍ بذاته بغض النظر عن صيغة السؤال.
const DEFINITIONAL_QUESTION_PATTERNS = [
  "ما هو",
  "ما هي",
  "ما تعريف",
  "ما مفهوم",
  "عرف لي",
  "وش هو",
  "ايش هو"
];

function isDefinitionalQuestion(normalizedText) {
  return containsAny(normalizedText, DEFINITIONAL_QUESTION_PATTERNS);
}

function isPracticalClear(normalizedText, questionTokens) {
  if (GUIDE_ENTRIES_NORMALIZED.length === 0) return false;
  const questionTokenSet = new Set(questionTokens);
  if (questionTokenSet.size === 0) return false;

  const isDefinitional = isDefinitionalQuestion(normalizedText);

  for (const entry of GUIDE_ENTRIES_NORMALIZED) {
    // تطابق قوي: نص عنوان الدليل بأكمله (بعد التطبيع) موجود كسلسلة
    // متصلة داخل نص السؤال — يبقى فعالاً حتى في الأسئلة التعريفية،
    // لأن تطابق عنوان كامل دليل قوي بذاته.
    if (entry.normalizedText && normalizedText.includes(entry.guideTitleNormalized)) {
      return true;
    }

    // تطابق ضعيف (تقاطع رموز): لا يُعتمَد إن كان السؤال تعريفيًا عامًا،
    // لتفادي أن يتحول سؤال معرفي مثل "ما هو الذكاء الاصطناعي" إلى
    // practical_clear لمجرد اشتراك كلمتين عامتين مع عنوان دليل غير
    // ذي صلة فعلية بمشكلة عملية.
    if (isDefinitional) continue;

    let overlap = 0;
    for (const t of entry.tokens) {
      if (questionTokenSet.has(t)) overlap++;
    }
    if (overlap >= MIN_TOKEN_OVERLAP) return true;
  }
  return false;
}

// ================================================================
// 4) practical_vague
// إشارة لمشكلة عملية بلا تفاصيل كافية — عبارات مرجعية قصيرة.
// ================================================================
const VAGUE_PATTERNS = [
  "عندي مشكله",
  "احتاج مساعده",
  "شيء معطل",
  "في مشكله",
  "ما ادري وش اسوي",
  "محتار وش اسوي"
];

function isPracticalVague(normalizedText) {
  return containsAny(normalizedText, VAGUE_PATTERNS);
}

// ================================================================
// 5) general_question
// بنية استفهامية معرفية واضحة.
// ================================================================
const QUESTION_WORD_PATTERNS = [
  "ما هو",
  "ما هي",
  "ماذا",
  "من هو",
  "من هي",
  "من اخترع",
  "كيف",
  "لماذا",
  "ما معني",
  "ما الفرق"
];

function isGeneralQuestion(normalizedText) {
  return containsAny(normalizedText, QUESTION_WORD_PATTERNS);
}

// ================================================================
// 6) out_of_scope
// نطاق ضيق جدًا: طلبات لا علاقة لها بحياة يومية ولا معرفة عامة.
// ================================================================
const OUT_OF_SCOPE_REQUEST_VERBS = ["اكتب لي", "اعطني", "صمم لي", "ابيك تسوي لي"];
const OUT_OF_SCOPE_TARGETS = [
  "كود اختراق",
  "برنامج اختراق",
  "اختراق موقع",
  "اختراق حساب",
  "فيروس",
  "ثغره اختراق"
];

function isOutOfScope(normalizedText) {
  const hasVerb = containsAny(normalizedText, OUT_OF_SCOPE_REQUEST_VERBS);
  const hasTarget = containsAny(normalizedText, OUT_OF_SCOPE_TARGETS);
  // التركيب مطلوب غالبًا، لكن بعض الأهداف صريحة الخطورة بذاتها كتركيب
  // (اختراق + موقع/حساب) حتى بلا فعل طلب صريح مسبوق بأدب الطلب.
  return hasTarget && (hasVerb || /اختراق (موقع|حساب|جهاز)/.test(normalizedText));
}

// ================================================================
// الدالة المُصدَّرة الوحيدة — نقطة الدخول الوحيدة لهذا الملف.
// ================================================================
export function classifyIntent(question) {
  try {
    if (typeof question !== "string" || !question.trim()) {
      return "unknown";
    }

    const normalizedText = normalizeArabic(question);
    if (!normalizedText) return "unknown";

    const questionTokens = tokenize(normalizedText);

    if (isInjectionAttempt(normalizedText)) return "injection_attempt";
    if (isSensitive(normalizedText)) return "sensitive";
    if (isPracticalClear(normalizedText, questionTokens)) return "practical_clear";
    if (isPracticalVague(normalizedText)) return "practical_vague";
    if (isGeneralQuestion(normalizedText)) return "general_question";
    if (isOutOfScope(normalizedText)) return "out_of_scope";

    return "unknown";
  } catch {
    // أي خطأ داخلي غير متوقع في أي مرحلة أعلاه → حياد آمن، لا رفض.
    return "unknown";
  }
}
