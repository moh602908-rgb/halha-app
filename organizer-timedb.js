/* ============================================================
   organizer-timedb.js — قاعدة زمنية منفصلة: dallini-organizer-time
   ============================================================
   منفصلة تمامًا عن organizer-db.js (dallini-organizer). لا تلمس ولا تستورد
   أي ملف من Foundation. تحمل مخزنين:
   - time_entities: منبّه/مؤقت/عدّ تنازلي/تذكير (مصدر حقيقة الوقت).
   - settings: سجل واحد ثابت المعرّف (الاسم، تفعيل الصوت، Premium).
   ============================================================ */

const TIME_DB_NAME = "dallini-organizer-time";
const TIME_DB_VERSION = 1;
const ENTITIES_STORE = "time_entities";
const SETTINGS_STORE = "settings";
const BLOCKED_UPGRADE_TIMEOUT_MS = 8000;

let dbPromise = null;

/** فتح/إنشاء القاعدة. اتصال واحد يُعاد استخدامه (نفس نمط organizer-db.js). */
export function openTimeDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(TIME_DB_NAME, TIME_DB_VERSION);
    let blockedTimer = null;

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(ENTITIES_STORE)) {
        const store = db.createObjectStore(ENTITIES_STORE, { keyPath: "id" });
        store.createIndex("kind_idx", "kind", { unique: false });
        store.createIndex("status_idx", "status", { unique: false });
        store.createIndex("occ_key_idx", "occ_key", { unique: false }); // لتذكيرات مرتبطة بموعد
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: "id" });
      }
    };

    request.onblocked = () => {
      blockedTimer = setTimeout(
        () => reject(new Error("organizer_time_db_blocked: ترقية القاعدة الزمنية محجوبة؛ أغلق نوافذ التطبيق الأخرى ثم أعد المحاولة")),
        BLOCKED_UPGRADE_TIMEOUT_MS
      );
    };
    request.onsuccess = (event) => {
      if (blockedTimer) clearTimeout(blockedTimer);
      const db = event.target.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = (event) => {
      if (blockedTimer) clearTimeout(blockedTimer);
      dbPromise = null;
      reject(event.target.error);
    };
  });
  return dbPromise;
}

/** إعادة تعيين اتصال الوحدة (للاختبارات فقط: سياق جديد يفتح اتصالًا جديدًا). */
export function _resetConnectionForTests() { dbPromise = null; }

export const _STORES = Object.freeze({ ENTITIES_STORE, SETTINGS_STORE });
