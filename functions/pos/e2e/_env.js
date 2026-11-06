// pos/e2e/_env.js — ตัวช่วยร่วมของเทส e2e บน Firestore emulator (ก้อน 4 · DEV-0001)
//
// ❌ ไม่แตะฐานจริงเด็ดขาด: โหลดไฟล์นี้ได้เมื่อ
//   ① FIRESTORE_EMULATOR_HOST ชี้ 127.0.0.1 / localhost / [::1] เท่านั้น
//   ② project id ขึ้นต้น `demo-` (Firebase ถือว่าเป็น project สมมติ ไม่มีของจริงให้ต่อ)
//   ③ ก่อนเทสแรก ยิงเขียน doc ตรวจผ่าน admin SDK แล้วอ่านกลับทาง REST ของ emulator ⇒ พิสูจน์ว่า SDK เขียนลง emulator จริง
//   ไม่ผ่านข้อไหน = throw ตอนโหลด (ไม่มีเทสไหนได้รัน)
// วิธีรัน = `npm run test:e2e` ใน functions/ (ดู run.js · เปิด emulator เอง · เลือก port ว่าง)
//
// handler ที่เรียก = ตัวจริงของ pos/* ผ่าน factory (deps.now ตรึงนาฬิกา) · db = functions/firebase ตัวจริงที่ต่อ emulator
"use strict";

const crypto = require("crypto");
const http = require("http");

const HOST = process.env.FIRESTORE_EMULATOR_HOST || "";
const PROJECT = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(HOST)) {
  throw new Error(`e2e: FIRESTORE_EMULATOR_HOST ต้องเป็นเครื่องนี้ (ได้ "${HOST}") · รันผ่าน npm run test:e2e`);
}
if (!/^demo-[a-z0-9-]+$/.test(PROJECT)) {
  throw new Error(`e2e: project id ต้องขึ้นต้น demo- (ได้ "${PROJECT}") · กันต่อ project จริง`);
}
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const { admin, db } = require("../../firebase");
const { Timestamp } = admin.firestore;

// ── พิสูจน์ว่าเขียนลง emulator จริง (ข้อ ③) ───────────────────────────────────
function restGet(path) {
  const [host, port] = [HOST.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""), Number(HOST.split(":").pop())];
  return new Promise((resolve, reject) => {
    const r = http.get({ host, port, path, headers: { Authorization: "Bearer owner" } }, (res) => {
      let s = "";
      res.on("data", (c) => { s += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: s }));
    });
    r.on("error", reject);
    r.setTimeout(5000, () => r.destroy(new Error("emulator ไม่ตอบ")));
  });
}
let readyP = null;
function ready() {
  if (!readyP) {
    readyP = (async () => {
      const id = `probe-${crypto.randomBytes(6).toString("hex")}`;
      await db.collection("_e2eProbe").doc(id).set({ at: new Date() });
      const r = await restGet(`/v1/projects/${PROJECT}/databases/(default)/documents/_e2eProbe/${id}`);
      if (r.status !== 200) throw new Error(`e2e: อ่าน doc ตรวจจาก emulator ไม่ได้ (${r.status}) · SDK อาจไม่ได้ต่อ emulator · หยุด`);
    })();
  }
  return readyP;
}

// ── ค่าและตัวช่วย ────────────────────────────────────────────────────────────
const ns = () => crypto.randomBytes(4).toString("hex");
const T = (iso) => Timestamp.fromDate(new Date(iso));
const ms = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : t instanceof Date ? t.getTime() : null);
const clock = (iso) => ({ now: () => new Date(iso) });

/** เรียก handler แบบ factory: make(deps)(req,res) · คืน {status, body} */
async function call(make, deps, { body, shopAccess, auth, extra } = {}) {
  const handler = make(deps || {});
  const res = {
    statusCode: 0, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
  };
  await handler({ body, shopAccess, auth, headers: {}, ...(extra || {}) }, res);
  return { status: res.statusCode, body: res.body };
}

async function seed(data) {
  const batch = db.batch();
  for (const [c, docs] of Object.entries(data)) {
    for (const [id, d] of Object.entries(docs)) batch.set(db.collection(c).doc(id), d);
  }
  await batch.commit();
}
const get = async (c, id) => {
  const s = await db.collection(c).doc(id).get();
  return s.exists ? s.data() : undefined;
};
const where = async (c, f, v) => (await db.collection(c).where(f, "==", v).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

/** ภาพทั้งฐาน (ทุก collection ทุก doc) เป็น JSON · ใช้พิสูจน์ "ปัดแล้วไม่เขียนอะไร" */
async function dump() {
  const out = {};
  for (const c of await db.listCollections()) {
    if (c.id === "_e2eProbe") continue;
    const s = await c.get();
    for (const d of s.docs) out[`${c.id}/${d.id}`] = JSON.stringify(d.data());
  }
  return out;
}

// ── ร้านตัวอย่าง (รูปจาก fixture ของ packages/schema · ค่าสมมติทั้งหมด) ─────────────
const OPEN_ISO = "2026-11-10T01:00:00.000Z"; // 08:00 เวลาไทย
const NOW_ISO = "2026-11-10T03:00:00.000Z"; // 10:00 เวลาไทย

const INITIAL_SHIFT = Object.freeze({
  closeBy: "", closeCash: "", closeComment: "", closeDiff: "", closeTime: "", closeWithDraw: "",
  duringShift: [], openBy: "", openCash: "", openComment: "", openDiff: "", openTime: "", openWithDraw: "",
  shopId: "", posId: "", currentCash: 0, status: false, lastShiftDate: "20230909", shiftCount: 0, receiptNumber: "",
});

/** ร้าน A (ร้านทดสอบ) + ร้าน B (ร้านอื่น) ต่อ namespace · คืน id ทุกตัวที่เทสใช้ */
function shopFixture(opts = {}) {
  const n = ns();
  const id = {
    n,
    shopA: `shopA${n}`, shopB: `shopB${n}`,
    sh1: `sh1${n}`, shB: `shB${n}`,
    owner: `u-owner${n}`, staff: `u-staff${n}`, staffNo: `u-staffNo${n}`,
    pWater: `pWater${n}`, pMeat: `pMeat${n}`, pCan: `pCan${n}`, pPack: `pPack${n}`, pB: `pB${n}`,
    m1: `m1${n}`, mB: `mB${n}`,
    link: `link${n}`,
  };
  const shopA = {
    shopId: id.shopA,
    name: "ร้านทดสอบ",
    receiptPattern: opts.receiptPattern || "month",
    POSs: [{ id: "pos-1", shiftId: id.sh1 }],
    humanResource: [
      { id: id.owner, name: "เจ้าของ", position: ["001"], status: "active" },
      { id: id.staff, name: "พนักงานบี", position: ["002"], status: "active", rights: ["116", "124"] },
      { id: id.staffNo, name: "พนักงานซี", position: ["002"], status: "active", rights: [] },
    ],
    vip: [{ type: "premium", expire: T("2027-01-01T00:00:00.000Z") }, { type: "staff", expire: T("2027-01-01T00:00:00.000Z") }],
    amendBill: true,
    creditPoint: false,
    franchiseId: "",
    ...(opts.shopA || {}),
  };
  const stock = (over) => ({
    shopId: id.shopA, barcode: "8850000000001", barcodeStatus: true, price: 20, cost: 12, stock: 50, unit: "ขวด",
    imageId: "", selfImage: false, category: ["AX008"], cashierShow: true, consignment: false, delivery: false, rent: false,
    vatExemption: false, promotion: { status: false, qty: "", price: "", startDate: T("2026-11-05T17:12:28Z"), endDate: T("2026-11-05T17:12:28Z") },
    safetyStock: { status: false, qty: "" }, priceLevelStatus: false, priceLevel: [], pointStatus: true, stockCountStatus: true,
    customQtyStatus: false, customPriceStatus: false, expReport: [], sku: "", updateTime: T("2026-11-05T17:12:29Z"), other: [],
    ...over,
  });
  const linkDetail = [{ linkMultiply: 6, unit: "แพ็ก", id: id.pPack }, { linkMultiply: 1, unit: "กระป๋อง", id: id.pCan }];
  const data = {
    shop: {
      [id.shopA]: shopA,
      [id.shopB]: { shopId: id.shopB, name: "ร้านอื่น", receiptPattern: "month", POSs: [{ id: "pos-9", shiftId: id.shB }], humanResource: [{ id: `u-b${n}`, name: "เจ้าของบี", position: ["001"], status: "active" }] },
    },
    billId: { [id.shopA]: { month: 11, receipts: 41 } },
    // doc กะ = รูป initialShift ของแอป (main3 src/config/initialShift.js · fixture testShopDoc ของ schema/test/shift.test.mjs) + เปิดกะแล้ว
    shift: {
      [id.sh1]: { ...INITIAL_SHIFT, shopId: id.shopA, posId: "pos-1", id: id.sh1, status: true, openTime: T(OPEN_ISO), openCash: "500", openId: id.owner, openName: "เจ้าของ", lastShiftDate: "20261110", shiftCount: 1 },
      [id.shB]: { ...INITIAL_SHIFT, shopId: id.shopB, posId: "pos-9", id: id.shB, status: true, openTime: T(OPEN_ISO), openCash: "0", openId: `u-b${n}`, openName: "เจ้าของบี", lastShiftDate: "20261110", shiftCount: 1 },
    },
    stock: {
      [id.pWater]: stock({ name: "น้ำดื่ม", stock: 50, cost: 6 }),
      [id.pMeat]: stock({ name: "หมูสับ", unit: "กิโลกรัม", stock: 10, cost: 80, price: 120 }),
      [id.pCan]: stock({ name: "โซดากระป๋อง", unit: "กระป๋อง", stock: 60, cost: 10, linkId: id.link, linkMultiply: 1, linkDetail, linkQty: 60, id: id.pCan }),
      [id.pPack]: stock({ name: "โซดาแพ็ก 6", unit: "แพ็ก", stock: 60, cost: 10, price: 110, linkId: id.link, linkMultiply: 6, linkDetail, linkQty: 10, id: id.pPack }),
      [id.pB]: stock({ shopId: id.shopB, name: "ของร้านบี", stock: 9 }),
    },
    member: {
      [id.m1]: { shopId: id.shopA, name: "ลูกค้าเอ", tel: "0000000000", point: 30, credit: 0, creditArray: [], bought: [], letter: "A" },
      [id.mB]: { shopId: id.shopB, name: "ลูกค้าร้านบี", tel: "0000000000", point: 5, credit: 0, creditArray: [] },
    },
    admin: { adminConfig: { admin: ["u-admin-e2e"] } },
  };
  if (opts.receiptPattern === "day") data.billDayId = { [id.shopA]: { date: 10, receipts: 5 } };
  const owner = { shopId: id.shopA, uid: id.owner, role: "owner", rights: [] };
  const staff = { shopId: id.shopA, uid: id.staff, role: "staff", rights: ["116", "124"] };
  const staffNo = { shopId: id.shopA, uid: id.staffNo, role: "staff", rights: [] };
  const ownerB = { shopId: id.shopB, uid: `u-b${n}`, role: "owner", rights: [] };
  return { id, data, access: { owner, staff, staffNo, ownerB } };
}

let seq = 0;
const uuid = (shopField) => `${shopField}${crypto.randomUUID()}`;
const reqId = () => crypto.randomUUID();
const tag = () => `T${++seq}`;

/** คำขอ sale.create รูปที่แอปส่ง · ค่าตั้งต้นเป็นบิลเงินสดน้ำ 2 ขวด */
function saleBody(f, over = {}) {
  return {
    shopId: f.id.shopA,
    receiptUUID: uuid(f.id.shopA),
    product: [{ id: f.id.pWater, qty: 2, name: "น้ำดื่ม", net: 20, totalPrice: 20, totalCost: 12 }],
    payment: [{ id: 1, amount: 100, name: "เงินสด", change: 80 }],
    moneyMustPaid: 20,
    manualDiscount: 0,
    productDiscount: 0,
    pointDiscount: { value: 0, point: 0 },
    campaign: [],
    pointToItem: [],
    cashierId: f.id.owner,
    cashierName: "เจ้าของ",
    posId: "pos-1",
    posNumber: "1",
    change: 80,
    shiftId: f.id.sh1,
    shiftOpenTime: OPEN_ISO,
    ...over,
  };
}

module.exports = {
  admin, db, Timestamp, ready, ns, T, ms, clock, call, seed, get, where, dump,
  shopFixture, saleBody, uuid, reqId, tag, OPEN_ISO, NOW_ISO, PROJECT, HOST, INITIAL_SHIFT,
};
