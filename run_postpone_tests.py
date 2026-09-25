import asyncio, hashlib, json, re, sys, threading, http.server, socketserver, functools, os
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
APPROVED = {   # ملفات يجب ألا تتغير إطلاقًا
 "organizer-db.js":"4b2be0327b23013e432a89abb601ce2b9a31386d3b7a1643527f51dd42b06df8",
 "organizer-crud.js":"bb4a02ac1c606837323f643eaecfbf040b98fc00e4009589f4155f432bdc050a",
 "organizer-recurrence.js":"06780bed9649fa5261d83197b58b000b4f1a0fbcd21222f43f1b2372d84d38fc",
}
MODIFIED_BASE = {  # الملفان المعدّلان: بصمة النسخة السابقة المعتمدة (للمقارنة فقط)
 "organizer-editing.js":"1b3dc53f92bfe3c76b1fbe2caa0c0fd4ad41a0712ee5b0ec9a114b06e717cdcf",
 "organizer-series-split.js":"79961257bee01c15f5f9e8bbdfb270234eaa5f0eb7be658dfbc3a055de206bad",
}
sha = lambda p: hashlib.sha256(open(os.path.join(ROOT,p),'rb').read()).hexdigest()

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Q, directory=ROOT))
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()

async def main():
    seen, blocked, cerrs, out = [], [], [], {}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        ctx = await browser.new_context(service_workers="block", timezone_id="America/New_York", locale="en-US")
        async def route(r):
            u = r.request.url
            if u.startswith(f"http://127.0.0.1:{PORT}/"): seen.append(u); await r.continue_()
            else: blocked.append(u); await r.abort()
        await ctx.route("**/*", route)
        for name, html in [("regression","test-series-split.html"), ("postpone","test-postpone.html")]:
            page = await ctx.new_page()
            page.on("console", lambda m: cerrs.append(m.text) if m.type=="error" else None)
            page.on("pageerror", lambda e: cerrs.append(str(e)))
            await page.goto(f"http://127.0.0.1:{PORT}/{html}")
            await page.wait_for_function("window.__DONE === true", timeout=180000)
            out[name] = (await page.evaluate("window.__RESULTS"), await page.evaluate("window.__ISOLATION"))
        await browser.close()
    httpd.shutdown()
    return out, seen, blocked, cerrs

out, seen, blocked, cerrs = asyncio.run(main())

def show(title, results):
    print(f"\n######## {title} ########")
    groups = {}
    for r in results: groups.setdefault(r["group"], []).append(r)
    for g, rs in groups.items():
        print(f"\n== {g} ==")
        for r in rs:
            print(("PASS " if r["pass"] else "FAIL ") + r["id"] + " — " + r["name"])
            if not r["pass"]: print("     ↳", r["detail"])
    p = sum(r["pass"] for r in results); print(f"\n{title}: {p}/{len(results)} PASS")
    return p, len(results)

reg, regiso = out["regression"]; pp, ppiso = out["postpone"]
show("انحدار (اختبارات Series Split + CRUD/Recurrence/Edit كما هي دون تعديل)", reg)
show("Postpone + الإصلاحات الجديدة", pp)

print("\n== عزل ==")
allf = list(APPROVED)+list(MODIFIED_BASE)+["organizer-postpone.js"]
def strip_comments(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S); return re.sub(r"(?m)^\s*//.*$", "", s)
banned = r"\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|sessionStorage|localStorage|\bimport\s*\(|importScripts|gemini|askAI|AI_ENDPOINT|api/ask|https?://"
for f in allf:
    m = re.findall(banned, strip_comments(open(os.path.join(ROOT,f),encoding="utf-8").read()), flags=re.I)
    print(("PASS " if not m else "FAIL ") + f"E-static {f}: لا شبكة/AI/Storage غير IndexedDB", m or "")
imports = re.findall(r'import\s+[^;]*from\s+"([^"]+)"', strip_comments(open(os.path.join(ROOT,"organizer-postpone.js"),encoding="utf-8").read()))
print(("PASS " if imports==["./organizer-db.js"] else "FAIL ") + "E-libs: استيرادات organizer-postpone.js =", imports)
print(("PASS " if not blocked else "FAIL ") + f"E-net: طلبات خارج localhost = {len(blocked)} {blocked}")
for nm,(_,iso) in out.items():
    print(("PASS " if iso["sessionStorageLength"]==0 and iso["localStorageLength"]==0 else "FAIL ") + f"E-storage[{nm}]: sessionStorage={iso['sessionStorageLength']} localStorage={iso['localStorageLength']}")
    print(("PASS " if iso["indexedDBNames"]==["dallini-organizer"] else "FAIL ") + f"E-idb[{nm}]: {iso['indexedDBNames']}")
print(("PASS " if not cerrs else "FAIL ") + f"E-console: {cerrs}")
print("\n== الملفات المعتمدة غير المعدّلة (3) ==")
for f,h in APPROVED.items():
    print(("PASS " if sha(f)==h else "FAIL ") + f"{f} SHA-256 {sha(f)[:12]}…")
print("\n== الملفات المعدّلة (2) ==")
for f,h in MODIFIED_BASE.items():
    print(("CHANGED " if sha(f)!=h else "UNCHANGED?! ") + f"{f} SHA-256 {sha(f)}")
print("\nSHA-256 organizer-postpone.js:", sha("organizer-postpone.js"))
json.dump({"regression":reg,"postpone":pp}, open(os.path.join(ROOT,"results-postpone.json"),"w"), ensure_ascii=False, indent=1)
