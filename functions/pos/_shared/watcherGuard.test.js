// เทสด่าน watcher ระดับทะเบียน route (DEV-0001 watcher · Pack เคาะ 2026-11-07 ข้อ 2)
//   watcher ถูกปัดเขียนที่ callerAccess ที่เดียว (ค่าตั้งต้น = ปัด) ⇒ route ร้านทุกตัวต้องผ่าน callerAccess
//   ยกเว้นเส้นอ่านที่ไม่เรียก callerAccess (ตาราง READ_WITHOUT_CALLER ข้างล่าง · เพิ่มตัวใหม่ = ต้องแก้ไฟล์นี้ให้เห็น)
//   ตรวจจากข้อความไฟล์ (ไม่ require handler ⇒ ไม่โหลด SDK จริง)
//   และ { read: true } มีได้เฉพาะไฟล์ในตาราง READ_FILES (กันใครเปิดเส้นเขียนให้ watcher เงียบ ๆ)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ROUTES } = require("../routes");
const { GATEWAY_ROUTES } = require("../gateway/routes");

const POS = path.resolve(__dirname, "..");
// เส้นอ่านล้วนที่อ่าน req.shopAccess เอง ไม่เรียก callerAccess
const READ_WITHOUT_CALLER = new Set(["system.ping", "shift.openList"]);
// ไฟล์ที่ได้ส่ง { read: true } (เส้นอ่าน หรือ op อ่านของเส้นผสม)
// announcement/feed.js (DEV-0003 0e) อ่านอย่างเดียว · watcher ไม่มีแถวในร้าน = ได้รายการว่าง
const READ_FILES = new Set(["sale/get.js", "report/_reportShared.js", "gateway/connections.js", "shopStaff/staffManage.js", "announcement/feed.js",
  // ScanGo: ค้นสินค้า (แกนของ relay products/list) · รายการใบ · สถานะไทล์ (อ่านอย่างเดียว)
  "scango/shop/productSearch.js", "scango/shop/orderList.js", "scango/shop/loginStatus.js",
  // DEV-0010 stock.sync · stock.findBarcode (อ่านสินค้าของร้านอย่างเดียว · แอปเดิมทุกคนในร้านอ่านได้)
  "stock/syncRead.js",
  // DEV-0010 expense.list · expenseReport.list (อ่านอย่างเดียว · watcher ได้สิทธิ์แบบเจ้าของ)
  "shopStaff/expenseRead.js",
  // DEV-0010 shop.get · company.catalog · notification.list (อ่านอย่างเดียว · watcher อ่านได้แบบ profile.loading)
  "shop/get.js", "company/catalog.js", "notification/list.js",
  // DEV-0010 shift.get · shift.history (อ่านกะอย่างเดียว · watcher อ่านได้แบบ sale.get)
  "shift/get.js", "shift/history.js"]);

function fileOf(load, base) {
  const m = /require\("(\.[^"]+)"\)/.exec(load.toString());
  assert.ok(m, "อ่าน path ของ handler จาก load() ไม่ได้");
  const p = path.resolve(base, m[1]);
  return fs.existsSync(p + ".js") ? p + ".js" : p;
}

// gateway ใช้ตัวช่วย shop(contract, path, file, fn) ⇒ อ่าน path จากข้อความทะเบียน
function gatewayShopRows() {
  const src = fs.readFileSync(path.join(POS, "gateway", "routes.js"), "utf8");
  return [...src.matchAll(/^\s*shop\("([^"]+)",\s*"[^"]+",\s*"(\.[^"]+)"/gm)].map((m) => ({ c: m[1], f: path.resolve(POS, "gateway", m[2]) + ".js" }));
}

test("route ร้าน (auth shop) ทุกตัวผ่าน callerAccess (หรือ openReport ที่เรียก callerAccess) · ยกเว้นเส้นอ่านในตาราง", () => {
  const rows = [
    ...ROUTES.filter((r) => r.auth === "shop").map((r) => ({ c: r.contract, f: fileOf(r.load, POS) })),
    ...gatewayShopRows(),
  ];
  assert.equal(gatewayShopRows().length, GATEWAY_ROUTES.filter((r) => r.auth === "shop").length);
  assert.ok(rows.length > 40);
  for (const { c, f } of rows) {
    if (READ_WITHOUT_CALLER.has(c)) continue;
    const src = fs.readFileSync(f, "utf8");
    assert.ok(/callerAccess\(|openReport\(/.test(src), `${c} (${path.relative(POS, f)}) ไม่ผ่าน callerAccess ⇒ watcher เขียนได้`);
  }
});

test("{ read: true } อยู่เฉพาะไฟล์ที่ประกาศ (เส้นอ่าน) · ไฟล์อื่นห้ามเปิดให้ watcher", () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return e.name === "e2e" ? [] : walk(p);
    return e.name.endsWith(".js") && !e.name.endsWith(".test.js") ? [p] : [];
  });
  for (const f of walk(POS)) {
    const rel = path.relative(POS, f);
    const src = fs.readFileSync(f, "utf8");
    if (/callerAccess\([^)]*\{\s*read:/.test(src)) assert.ok(READ_FILES.has(rel), `${rel} เปิด { read } ให้ watcher โดยไม่อยู่ในตาราง`);
  }
});
