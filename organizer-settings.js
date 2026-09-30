/* ============================================================
   organizer-settings.js — إعدادات شخصية: الاسم، تفعيل الصوت، Premium
   ============================================================
   سجل واحد ثابت المعرّف "settings" في dallini-organizer-time.
   لا شبكة، لا استيراد لـ app.js/ask.js/prompt.js/api/.
   ============================================================ */

import { openTimeDB, _STORES } from "./organizer-timedb.js";

const SETTINGS_ID = "settings";
const NAME_MAX_LENGTH = 60;

const DEFAULTS = Object.freeze({
  id: SETTINGS_ID,
  display_name: null,
  voice_reminders_enabled: false,
  premium_active: false,
  voice_options: null, // محجوز لخيارات Premium متقدمة، غير مُستخدم في V1
});

/** الإعدادات الحالية، مدمجة مع الافتراضات (لا ترمي إن كان السجل غير موجود بعد). */
export async function getSettings() {
  const db = await openTimeDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_STORES.SETTINGS_STORE, "readonly");
    const req = tx.objectStore(_STORES.SETTINGS_STORE).get(SETTINGS_ID);
    req.onsuccess = () => resolve({ ...DEFAULTS, ...(req.result || {}) });
    req.onerror = () => reject(req.error);
  });
}

function assertValidPatch(patch) {
  if (Object.prototype.hasOwnProperty.call(patch, "display_name")) {
    const v = patch.display_name;
    if (v !== null && (typeof v !== "string" || v.trim() === "" || v.length > NAME_MAX_LENGTH)) {
      throw new Error("organizer_settings_invalid_name: الاسم يجب أن يكون نصًا غير فارغ لا يتجاوز 60 حرفًا، أو null");
    }
  }
  for (const f of ["voice_reminders_enabled", "premium_active"]) {
    if (Object.prototype.hasOwnProperty.call(patch, f) && typeof patch[f] !== "boolean") {
      throw new Error(`organizer_settings_invalid_field:${f}: يجب أن تكون قيمة منطقية`);
    }
  }
}

/** تحديث جزئي للإعدادات (دمج). يطبّع display_name (trim)، ويرفض قيمًا غير صالحة بلا كتابة. */
export async function updateSettings(patch = {}) {
  assertValidPatch(patch);
  const clean = { ...patch };
  if (typeof clean.display_name === "string") clean.display_name = clean.display_name.trim() || null;
  const db = await openTimeDB();
  const current = await getSettings();
  const merged = { ...current, ...clean, id: SETTINGS_ID, updated_at: Date.now() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_STORES.SETTINGS_STORE, "readwrite");
    tx.objectStore(_STORES.SETTINGS_STORE).put(merged);
    tx.oncomplete = () => resolve(merged);
    tx.onerror = () => reject(tx.error);
  });
}
