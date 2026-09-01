/* ============================================================
   scripts/extract-guides-index.mjs
   ============================================================
   الغاية: استخلاص عناوين المجالات والأدلة فقط من app.js إلى
   api/_lib/guides-index.json — لاستخدام intent.js لاحقًا في
   تصنيف "practical_clear".

   قواعد صارمة (Fail-Closed):
   1) يقرأ app.js كنص فقط — لا يُشغَّل الملف كاملًا أبدًا (لأن باقي
      app.js يعتمد على document/window غير الموجودين في Node).
   2) لا يعدّل app.js إطلاقًا تحت أي ظرف.
   3) أي نقص أو خطأ في البيانات المستخرجة → توقف كامل، لا كتابة
      لأي ملف ناتج، ولا كتابة جزئية.
   4) الناتج يقتصر حصرًا على: domainId, domainName, guideTitle
      + حقول تحقق منفصلة (totalDomains, totalGuides, generatedAt,
      sourceFile) لا يقرأها منطق التشغيل، للمراجعة البشرية فقط.

   الاستخدام: node scripts/extract-guides-index.mjs
   يُشغَّل يدويًا عند أي إضافة/تعديل لدليل داخل app.js.
   ============================================================ */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SOURCE_FILE = join(ROOT, "app.js");
const OUTPUT_FILE = join(ROOT, "api", "_lib", "guides-index.json");

// الأرقام المرجعية المؤكَّدة يدويًا وقت تصميم هذه الخطوة (Phase 12.3.0).
// أي انحراف عنها في هذا التشغيل تحديدًا يوقف السكربت للمراجعة البشرية،
// بدل قبول أي عدد صامتًا. عند تحديث الأدلة مستقبلاً، يُحدَّث هذان الرقمان
// يدويًا هنا بعد مراجعة واعية للتغيير — وهذا الملف الوحيد الذي يحتاج لمسًا
// عند إضافة/حذف مجال أو دليل، وليس أي جزء من intent.js أو guides-index.json.
const EXPECTED_TOTAL_DOMAINS = 24;
const EXPECTED_TOTAL_GUIDES = 168;

function fail(message) {
  console.error(`\n❌ فشل الاستخلاص: ${message}`);
  console.error("   لم يُكتب أي ملف ناتج.\n");
  process.exit(1);
}

function main() {
  console.log("🔎 بدء استخلاص عناوين الأدلة من app.js ...\n");

  if (!existsSync(SOURCE_FILE)) {
    fail(`الملف المصدر غير موجود: ${SOURCE_FILE}`);
  }

  const sourceText = readFileSync(SOURCE_FILE, "utf8");

  // --- 1) عزل مقطع "const DOMAINS = [ ... ];" بدقة عبر عدّاد أقواس ---
  const startMarker = "const DOMAINS = [";
  const startIdx = sourceText.indexOf(startMarker);
  if (startIdx === -1) {
    fail(`لم يُعثر على "const DOMAINS = [" في app.js — البنية تغيّرت عن المتوقع.`);
  }

  // نبدأ العدّ من القوس المفتوح نفسه (نهاية startMarker - 1 هو "[")
  const arrayStart = startIdx + startMarker.length - 1; // موضع "["
  let depth = 0;
  let endIdx = -1;
  for (let i = arrayStart; i < sourceText.length; i++) {
    const ch = sourceText[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) {
    fail("لم يُعثر على إغلاق مطابق لمصفوفة DOMAINS (أقواس غير متوازنة أو تغيّر في البنية).");
  }

  const arrayLiteralText = sourceText.slice(arrayStart, endIdx + 1);

  // --- 2) تقييم المقطع المعزول فقط كبيانات JS خام (لا تشغيل لبقية app.js) ---
  let DOMAINS;
  try {
    const script = new vm.Script(`(${arrayLiteralText})`);
    const context = vm.createContext({});
    DOMAINS = script.runInContext(context, { timeout: 5000 });
  } catch (e) {
    fail(`تعذّر تقييم مصفوفة DOMAINS كبيانات JavaScript صالحة: ${e.message}`);
  }

  if (!Array.isArray(DOMAINS) || DOMAINS.length === 0) {
    fail("النتيجة المستخرجة ليست مصفوفة صالحة أو أنها فارغة.");
  }

  // --- 3) التحقق الصارم + الاستخراج المحدود (domainId/domainName/guideTitle فقط) ---
  const result = [];
  for (const [dIdx, domain] of DOMAINS.entries()) {
    const domainId = typeof domain?.id === "string" ? domain.id.trim() : "";
    const domainName = typeof domain?.name === "string" ? domain.name.trim() : "";

    if (!domainId) fail(`مجال بالفهرس ${dIdx} بدون "id" صالح.`);
    if (!domainName) fail(`مجال "${domainId || dIdx}" بدون "name" صالح.`);
    if (!Array.isArray(domain?.guides) || domain.guides.length === 0) {
      fail(`مجال "${domainId}" بدون مصفوفة "guides" صالحة أو أنها فارغة.`);
    }

    for (const [gIdx, guide] of domain.guides.entries()) {
      const guideTitle = typeof guide?.title === "string" ? guide.title.trim() : "";
      if (!guideTitle) {
        fail(`دليل بالفهرس ${gIdx} داخل مجال "${domainId}" بدون "title" صالح.`);
      }
      result.push({ domainId, domainName, guideTitle });
    }
  }

  // --- 4) تحقق صارم من الأرقام المرجعية قبل أي كتابة ---
  const totalDomains = DOMAINS.length;
  const totalGuides = result.length;

  if (totalDomains !== EXPECTED_TOTAL_DOMAINS) {
    fail(
      `عدد المجالات المستخرجة (${totalDomains}) لا يطابق العدد المرجعي المتوقع ` +
      `(${EXPECTED_TOTAL_DOMAINS}). إن كانت هذه إضافة/حذف مجال مقصود، حدّث ` +
      `EXPECTED_TOTAL_DOMAINS في هذا السكربت بعد مراجعة واعية، ثم أعد التشغيل.`
    );
  }
  if (totalGuides !== EXPECTED_TOTAL_GUIDES) {
    fail(
      `عدد الأدلة المستخرجة (${totalGuides}) لا يطابق العدد المرجعي المتوقع ` +
      `(${EXPECTED_TOTAL_GUIDES}). إن كانت هذه إضافة/حذف دليل مقصود، حدّث ` +
      `EXPECTED_TOTAL_GUIDES في هذا السكربت بعد مراجعة واعية، ثم أعد التشغيل.`
    );
  }

  // --- 5) بناء الناتج النهائي وكتابته (فقط بعد اجتياز كل الفحوصات أعلاه) ---
  const output = {
    _comment: "ملف مشتق آليًا من app.js عبر scripts/extract-guides-index.mjs. لا يُعدَّل يدويًا أبدًا. لأغراض التصنيف في intent.js فقط.",
    generatedAt: new Date().toISOString(),
    sourceFile: "app.js",
    totalDomains,
    totalGuides,
    guides: result
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n", "utf8");

  // --- 6) تقرير التحقق على الطرفية ---
  console.log("✅ نجح الاستخلاص والتحقق.\n");
  console.log(`   المجالات: ${totalDomains}`);
  console.log(`   الأدلة: ${totalGuides}`);
  console.log(`   الملف الناتج: ${OUTPUT_FILE}\n`);
  console.log("   أول عنوانين مستخرجين:");
  console.log(`     1. [${result[0].domainName}] ${result[0].guideTitle}`);
  console.log(`     2. [${result[1].domainName}] ${result[1].guideTitle}`);
  console.log("   آخر عنوانين مستخرجين:");
  console.log(`     ${totalGuides - 1}. [${result[totalGuides - 2].domainName}] ${result[totalGuides - 2].guideTitle}`);
  console.log(`     ${totalGuides}. [${result[totalGuides - 1].domainName}] ${result[totalGuides - 1].guideTitle}\n`);
}

main();
