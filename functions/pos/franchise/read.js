// pos/franchise/read.js — เส้นอ่านของเว็บแฟรนไชส์ (ก้อน 9f · DEV-0002) · อ่านอย่างเดียว ไม่เขียนฐาน
//
// สัญญา: shopchamp-center/api/franchise.{list,get,warehouseList,linkList,branchList}.yaml
// แทนจุดอ่านตรงของเว็บ (census chunk6-log.md):
//   list          272 273 `fr:screens/FranchiseListScreen.js:64,93` (array-contains humanResource · ทีมงานอ่านทุก doc)
//   get           262 274 289 `fr:ProfileScreen.js:30` `FranchiseListScreen.js:130` `redux/franchiseSlice.js:13`
//   warehouseList 290 `fr:redux/warehouseSlice.js:16`
//   linkList      283 `fr:redux/stockLinkSlice.js:19`
//   branchList    287 `fr:redux/shopSlice.js:15` (FD-B2: ไม่มี humanResource ในคำตอบเลย ⇒ รหัสพนักงานไม่วิ่งผ่าน network)
"use strict";

const { db } = require("../../firebase");
const F = require("./_franchise");
const WR = require("../_shared/watcherRoster");

const plain = (ref) => ref.get();
const tsSort = (rows, dir) => rows.sort((a, b) => {
  const x = a.timestamp || "", y = b.timestamp || "";
  return x === y ? 0 : (x < y ? -1 : 1) * dir;
});

// ── franchise.list ──
const LIST_MAX = 1000;
const list = F.makeHandler("FranchiseListRequest", async ({ uid }) => {
  // ทีมงาน (root หรือ watcher จาก watcher/roster) เห็นทุกแฟรนไชส์ · คนอื่นเห็นที่ตัวเองอยู่
  const roster = WR.snapToRoster(await WR.rosterRef(db).get());
  const staffRole = WR.staffRoleOf(roster, uid);
  const staff = staffRole !== WR.ROLE.NONE;
  const q = staff ? db.collection("franchise").limit(LIST_MAX + 1) : db.collection("franchise").where("humanResource", "array-contains", uid);
  const snap = await q.get();
  const rows = [];
  for (const d of snap.docs) {
    const f = d.data() || {};
    // แถวของตัวเองไม่ใช้งาน = ไม่ขึ้นในรายการ (เปิดแล้วก็ถูกปัดที่ franchise.get)
    if (!staff && !F.franchiseAccessOf({ franchise: f, uid, roster }).ok) continue;
    rows.push({ id: d.id, name: F.str(f.name), imageId: F.str(f.imageId), timestamp: F.isoOf(f.timestamp) });
  }
  const truncated = rows.length > LIST_MAX;
  // ใหม่ไปเก่าตามเดิม (normalSort) · doc ไม่มี timestamp อยู่ท้าย ไม่ทำให้ทั้งรายการล้ม (FL-17)
  const out = tsSort(rows.slice(0, LIST_MAX), -1);
  // staffRole บอกเว็บว่าเป็นทีมงานระดับไหน · root คง byAdmin:true ให้เว็บรุ่นที่อ่านช่องนี้อยู่
  return {
    franchises: out, count: out.length, ...(truncated ? { truncated: true } : {}),
    ...(staff ? { staffRole } : {}), ...(staffRole === WR.ROLE.ROOT ? { byAdmin: true } : {}),
  };
});

// ── franchise.get ──
const get = F.makeHandler("FranchiseGetRequest", async ({ uid, input }) => {
  const { franchise: f, access } = await F.readGate(plain, input.franchiseId, uid, {});
  return {
    franchise: {
      id: input.franchiseId,
      name: F.str(f.name),
      imageId: F.str(f.imageId),
      timestamp: F.isoOf(f.timestamp),
      // doc เก่าขาดช่องได้ ⇒ ค่าตั้งต้นเหมือน initialFranchise (F25 · WC-08 · SF-40 เดิมจอขาว)
      warehouseCategory: F.arr(f.warehouseCategory),
      humanRight: F.arr(f.humanRight).filter(F.isObj).map(F.staffRow),
      humanResource: F.arr(f.humanResource).filter((x) => typeof x === "string"),
      ...(typeof f.type === "string" ? { type: f.type } : {}),
    },
    access: { rights: access.rights, ...F.staffFlag(access) },
  };
});

// ── franchise.warehouseList ──
const num = (v) => { const n = Number(v); return v === "" || v === null || v === undefined || !Number.isFinite(n) ? null : n; };
const bool = (v, d) => (typeof v === "boolean" ? v : d);
function warehouseRow(id, d) {
  return {
    id,
    name: F.str(d.name),
    price: num(d.price),
    barcode: d.barcode === undefined || d.barcode === null ? "" : String(d.barcode),
    sku: d.sku === undefined || d.sku === null ? "" : String(d.sku),
    unit: typeof d.unit === "string" ? d.unit : "ชิ้น",
    category: F.categoryIdsOf(d.category),
    imageId: F.str(d.imageId),
    pointStatus: bool(d.pointStatus, true),
    stockCountStatus: bool(d.stockCountStatus, true),
    customQtyStatus: bool(d.customQtyStatus, false),
    customPriceStatus: bool(d.customPriceStatus, false),
    priceLevelStatus: bool(d.priceLevelStatus, false),
    priceLevel: F.arr(d.priceLevel).filter(F.isObj).map((p) => ({ qty: num(p.qty), price: num(p.price) })),
    timestamp: F.isoOf(d.timestamp),
  };
}
const warehouseList = F.makeHandler("FranchiseWarehouseListRequest", async ({ uid, input }) => {
  await F.readGate(plain, input.franchiseId, uid, { rights: [F.RIGHT.WAREHOUSE] });
  const snap = await db.collection("warehouseItem").where("franchiseId", "==", input.franchiseId).get();
  const rows = snap.docs.map((d) => warehouseRow(d.id, d.data() || {}));
  return { items: tsSort(rows, 1), count: rows.length };
});

// ── franchise.linkList ──
const linkList = F.makeHandler("FranchiseLinkListRequest", async ({ uid, input }) => {
  await F.readGate(plain, input.franchiseId, uid, { rights: [F.RIGHT.WAREHOUSE] });
  const snap = await db.collection("stockLink").where("franchiseId", "==", input.franchiseId).get();
  const rows = [];
  for (const d of snap.docs) {
    const l = d.data() || {};
    if (F.str(l.shopId) !== "") continue; // ตระกูลร้าน (ไม่ควรมี franchiseId) ไม่ใช่ของเว็บนี้
    const members = F.arr(l.stockLink).filter(F.isObj).map((m) => ({
      id: F.str(m.id), name: F.str(m.name), unit: F.str(m.unit), barcode: F.str(m.barcode), imageId: F.str(m.imageId), linkMultiply: num(m.linkMultiply),
    }));
    // เรียงตัวคูณแบบตัวเลข (SL-27 · เดิมเรียงสตริงได้ 1, 10, 2)
    members.sort((a, b) => (a.linkMultiply === null) - (b.linkMultiply === null) || (a.linkMultiply || 0) - (b.linkMultiply || 0));
    rows.push({ id: d.id, stockGroupName: F.str(l.stockGroupName), stockLink: members, upgrade: l.upgrade !== false, timestamp: F.isoOf(l.timestamp) });
  }
  return { links: tsSort(rows, 1), count: rows.length };
});

// ── franchise.branchList ──
const branchList = F.makeHandler("FranchiseBranchListRequest", async ({ uid, input }) => {
  // Dashboard ยอดตามร้าน และจอสาขาใช้รายการเดียวกัน (fr:FranchisorScreen.js:43) ⇒ สมาชิกทุกคนอ่านได้
  await F.readGate(plain, input.franchiseId, uid, {});
  const snap = await db.collection("shop").where("franchiseId", "==", input.franchiseId).get();
  const seen = new Set();
  const rows = [];
  for (const d of snap.docs) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const s = d.data() || {};
    rows.push({ id: d.id, name: F.str(s.name), tel: F.str(s.tel), dateTime: F.isoOf(s.dateTime) });
  }
  return { branches: rows, count: rows.length };
});

module.exports = { list, get, warehouseList, linkList, branchList, warehouseRow };
