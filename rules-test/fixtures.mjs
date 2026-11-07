// fixtures.mjs — ร้าน บัญชี และเอกสารตั้งต้นของเทส rules (DEV-0001 ก้อน 6)
//
// ร้าน 3 แบบที่มีจริงในฐาน (chunk4-verify/sale.get.md · schema/shop.md S5):
//   A = ร้านปกติ: doc id = field shopId (ร้านที่สร้างจาก NewShopScreen)
//   L = ร้านรุ่นเก่า (S5 ราว 19%): field shopId = uid เจ้าของ ≠ doc id · humanResource ที่ LoadingScreen สร้าง (ไม่มี status rights)
//   B = ร้านอื่น (ใช้ทดสอบข้ามร้าน)
// rules อ่านกติกาจาก RULES_FILE (ไม่ตั้ง = ../firestore.rules) ⇒ รันชุดเดียวกันกับ rules เก่าได้ เพื่อเทียบ 2 ทิศ
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, Timestamp } from "firebase/firestore";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RULES_FILE = process.env.RULES_FILE ? resolve(process.env.RULES_FILE) : join(HERE, "..", "firestore.rules");

// uid ของ Firebase Auth แบบอีเมลยาว 28 ตัว · doc id อัตโนมัติยาว 20 ตัว
const uid = (s) => (s + "0000000000000000000000000000").slice(0, 28);
export const U = {
  ownerA: uid("ownerA"), staffA: uid("staffA"), staffA99: uid("staffIdx79"), staffA100: uid("staffIdx80"), inactiveA: uid("inactiveA"),
  ownerL: uid("ownerLegacy"), staffL: uid("staffLegacy"),
  ownerB: uid("ownerB"), staffB: uid("staffB"),
  team: uid("teamAppAdmin"), teamWeb: uid("teamWebAdmin"),
  franchise: uid("franchiseOwner"), franchiseB: uid("franchiseOther"),
  shared: uid("sharedWebOwner"), outsider: uid("outsider"),
  watcher: uid("watcherRoster"), // DEV-0001: อยู่ใน watcher/roster.uids อย่างเดียว (ไม่อยู่ในร้าน/แฟรนไชส์/adminConfig)
};
export const SHARED_EMAIL = "owner@gmail.com";

export const SHOP_A = { docId: "shopAaaaaaaaaaaaaaaa", shopId: "shopAaaaaaaaaaaaaaaa", owner: U.ownerA, staff: U.staffA, label: "ร้านปกติ" };
export const SHOP_L = { docId: "legacyDocLllllllllll", shopId: U.ownerL, owner: U.ownerL, staff: U.staffL, label: "ร้านรุ่นเก่า S5" };
export const SHOP_B = { docId: "shopBbbbbbbbbbbbbbbb", shopId: "shopBbbbbbbbbbbbbbbb", owner: U.ownerB, staff: U.staffB, label: "ร้านอื่น" };
export const FR = "franchiseF1aaaaaaaaa";
export const FR_EMPTY = "franchiseNewaaaaaaaa";
export const FR_B = "franchiseFBbbbbbbbbb";

export const initialRights = ["101", "102", "103", "104", "105", "106", "107"];
const ts = (d = "2026-11-06T10:00:00+07:00") => Timestamp.fromDate(new Date(d));

function hrNormal(shop) {
  const filler = Array.from({ length: 96 }, (_, i) => ({ id: uid("filler" + i), position: ["002"], status: "active", rights: [], name: "f" + i }));
  return [
    { id: shop.owner, position: ["001"], status: "active", name: "เจ้าของ", imageId: "", email: "o@x.com", rights: initialRights },
    { id: shop.staff, position: ["002"], status: "active", name: "พนักงาน", imageId: "", email: "", tel: "0800000000", rights: ["101"], password: "1234" },
    { id: U.inactiveA, position: ["002"], status: "inActive", name: "ออกแล้ว", rights: [] },
    ...filler.slice(0, 76),
    { id: U.staffA99, position: ["002"], status: "active", name: "คนที่ 80", rights: [] }, // index 79 = ช่องสุดท้ายที่ rules ไล่ถึง
    { id: U.staffA100, position: ["002"], status: "active", name: "คนที่ 81", rights: [] }, // index 80 = เกินเพดาน
    ...filler.slice(76), // รวม 101 คน · คนนอกต้องไล่ครบ 80 ช่องโดยไม่ชนเพดาน 1,000 expression
  ];
}

export function shopDoc(shop, extra = {}) {
  const isA = shop === SHOP_A;
  return {
    id: shop.docId, shopId: shop.shopId, name: shop.label, tel: shop === SHOP_B ? "0811111111" : "0899999999",
    scShopId: 1, vip: [{ type: "staff", expire: ts("2027-01-01T00:00:00Z") }], dateTime: ts(),
    humanResource: shop === SHOP_L
      ? [{ id: shop.owner, position: ["001"], name: "เจ้าของเก่า", imageId: "", email: "", tel: "" }, { id: shop.staff, position: ["002"], status: "active", rights: ["101"] }]
      : isA ? hrNormal(shop) : [{ id: shop.owner, position: ["001"], status: "active", rights: initialRights }, { id: shop.staff, position: ["002"], status: "active", rights: [] }],
    POSs: [{ id: "pos-1", name: "แคชเชียร์ 1", shiftId: shop.docId + "-shift" }],
    smartCategory: [], totalMember: 10, notiShift: [shop.owner],
    line: { liff: "", channelAccessToken: "token-ลับ", userId: "" },
    ...(isA ? { franchiseId: FR } : {}),
    ...extra,
  };
}

// เอกสารตั้งต้นของแต่ละร้าน (id ลงท้ายด้วยตัวย่อร้าน)
export function shopSeed(shop) {
  const s = shop.shopId;
  const k = shop === SHOP_A ? "A" : shop === SHOP_L ? "L" : "B";
  const docs = {
    [`shop/${shop.docId}`]: shopDoc(shop),
    [`shift/${shop.docId}-shift`]: { shopId: s, posId: "pos-1", id: shop.docId + "-shift", status: false, duringShift: [], openTime: "", lastShiftDate: "20261105", shiftCount: 1 },
    [`billId/${shop.docId}`]: { month: 11, receipts: 10 },
    [`billDayId/${shop.docId}`]: { date: "20261106", receipts: 3 },
    [`taxId/${s}`]: { month: 11, receipts: 2 },
    [`member/member${k}1`]: { shopId: s, name: "สมาชิก", tel: "0812345678", point: 10, credit: 50, creditArray: [{ remainCredit: 20, billId: "x" }], bought: [], letter: "Q", timestamp: ts() },
    [`memberList/Q${s}`]: { shopId: s, members: [{ id: `member${k}1`, name: "สมาชิก", tel: "0812345678" }], updateTime: ts() },
    [`bill/bill${k}1`]: { shopId: s, franchiseId: k === "A" ? FR : "", receiptNumber: "R2611-0010", dateTime: ts(), billDate: "20261106", member: { id: `member${k}1` }, status: true, shiftId: shop.docId + "-shift", product: [], net: 100 },
    [`paidHistory/paid${k}1`]: { shopId: s, memberId: `member${k}1`, timestamp: ts(), pay: 20 },
    [`notification/noti${k}1`]: { shopId: s, heading: "h", notificationContent: "c", categoryId: 1, timestamp: ts() },
    [`checkIn/${s}${shop.staff}`]: { shopId: s, profileId: shop.staff, clockIn: ts(), clockInImage: "", billDate: "20261106000000", id: "" },
    [`checkInHistory/chk${k}1`]: { shopId: s, profileId: shop.staff, id: `${s}${shop.staff}`, clockIn: ts(), clockOut: ts(), billDate: "20261106" },
    [`expense/exp${k}1`]: { shopId: s, name: "ค่าน้ำ", price: 100, timestamp: ts() },
    [`expenseReport/rep${k}1`]: { shopId: s, month: "202611", expenses: [{ id: "e1", price: 10, note: "" }] },
    [`importProduct/imp${k}1`]: { shopId: s, dateTime: ts(), date: "20261106", product: [{ id: `stock${k}1`, qty: 1 }], supplierId: "" },
    [`supplier/sup${k}1`]: { shopId: s, name: "ผู้ขาย", tel: "" },
    [`promotion/pro${k}1`]: { shopId: s, id: `pro${k}1`, name: "โปร", status: true },
    [`stockLink/link${k}1`]: { shopId: s, id: `link${k}1`, linkDetail: [{ id: `stock${k}1`, linkMultiply: 1 }, { id: `stock${k}2`, linkMultiply: 12 }] },
    [`shiftHistory/sh${k}1`]: { shopId: s, posId: "pos-1", id: shop.docId + "-shift", lastShiftDate: "20261105", closeCash: "100" },
    [`requisition/req${k}1`]: { shopId: s, billDate: "20261106", product: [] },
    [`priceTag/tag${k}1`]: { shopId: s, products: [], timestamp: ts() },
    [`uploadProduct/up${k}1`]: { shopId: s, barcodes: ["885"], timestamp: ts() },
    [`pgWebhook/pg${k}1`]: { shopId: s, process: "request", timestamp: ts() },
    [`stockReport/srep${k}1`]: { shopId: s, timestamp: ts() },
    [`packageOrder/po${k}1`]: { shopId: s, orderNumber: "000001" },
    [`hardwareOrder/ho${k}1`]: { shopId: s, orderNumber: "000001" },
    [`imageOrder/io${k}1`]: { shopId: s, orderNumber: "000001" },
    [`stockOrder/so${k}1`]: { shopId: s, orderNumber: "000001" },
  };
  for (let i = 1; i <= 40; i++) {
    docs[`stock/stock${k}${i}`] = { shopId: s, name: `สินค้า ${i}`, barcode: `885${k}${i}`, stock: 100, cost: 5, price: 10, updateTime: ts(), linkId: i <= 2 ? `link${k}1` : "", linkDetail: i <= 2 ? [{ id: `stock${k}1` }, { id: `stock${k}2` }] : [], deleted: false };
  }
  return docs;
}

export function globalSeed() {
  return {
    "admin/adminConfig": { admin: [U.team], mainAds: [] },
    // ทะเบียน watcher (server เขียน) · team ของเลนเก่าไม่อยู่ในนี้ ⇒ 2 เลนแยกกันชัด
    "watcher/roster": { uids: [U.watcher], rootUids: [], people: [{ uid: U.watcher, name: "ทีมงานดูอย่างเดียว" }] },
    "watcherWriteLog/w1": { uid: U.watcher, op: "franchise.branchAttach" },
    "admin/admin": { value: [U.teamWeb] },
    "admin/updateShopchamp": { android: { appUrl: "", detail: [], isMustUpdate: false, isPackageOn: true, lastedVersion: 1 }, ios: { lastedVersion: 1 } },
    "admin/package": { payment: [], detail: [] },
    "admin/apk": { url: "" },
    "admin/hardware": { items: [] },
    "admin/question": { items: [] },
    "admin/packageNumber": { value: 5, timestamp: ts() },
    "admin/hardwareNumber": { value: 5, timestamp: ts() },
    "admin/imageNumber": { value: 5, timestamp: ts() },
    "admin/stockNumber": { value: 5, timestamp: ts() },
    "shopchamShopId/numOfStore": { total: 57325 },
    [`shopAlias/${SHOP_L.shopId}`]: { docIds: [SHOP_L.docId] },
    [`profile/${U.staffA}`]: { name: "พนักงาน", tel: "0800000000", email: "", port: [{ shopId: SHOP_A.shopId, shopName: "A", logo: "" }], currentLogin: { shopId: SHOP_A.shopId, printer: [], rights: ["101"] } },
    [`profile/${U.ownerB}`]: { name: "เจ้าของ B", tel: "0811111111", port: [], currentLogin: { shopId: SHOP_B.shopId } },
    [`profile/${U.franchise}`]: { name: "แฟรนไชส์", tel: "", port: [], currentLogin: { shopId: "" } },
    "product/prod1": { barcode: "8850001", name: "น้ำ", unit: "ขวด", imageId: "" },
    "buildings/LON": { geohash: "gcpvj", lat: 51.5, lng: 0.12 },
    [`franchise/${FR}`]: { name: "แฟรนไชส์ 1", humanResource: [U.franchise], humanRight: [{ id: U.franchise, rights: [] }], timestamp: ts(), warehouseCategory: [] },
    [`franchise/${FR_EMPTY}`]: { name: "เพิ่งสร้าง", humanResource: [], humanRight: [], timestamp: ts() },
    [`franchise/${FR_B}`]: { name: "แฟรนไชส์อื่น", humanResource: [U.franchiseB], humanRight: [], timestamp: ts() },
    [`warehouseItem/wh1`]: { franchiseId: FR, name: "ของคลัง", stock: 0, timestamp: ts() },
    [`warehouseItem/whB`]: { franchiseId: FR_B, name: "ของคลังอื่น", stock: 0, timestamp: ts() },
    [`stockLink/frLink1`]: { franchiseId: FR, id: "frLink1", linkDetail: [] },
    "loginByScan/scan1": { uid: "", docId: "scan1", timestamp: ts() },
    "deletedUser/del1": { uid: U.staffA, isDeleteSuccess: true, authenBy: "password", deleteReason: "" },
    "deletedUser/delB": { uid: U.ownerB, isDeleteSuccess: true, authenBy: "password", deleteReason: "" },
    "receiptGuard/guardB": { createdAt: ts(), usedBy: "billB1" },
    // ของ server/ใหม่ ที่ client ต้องแตะไม่ได้
    [`gatewayCreds/${SHOP_A.docId}`]: { ntt: { password: "ลับ" } },
    [`gatewayStations/${SHOP_A.docId}`]: { x: 1 },
    [`beamMerchantCreds/${SHOP_A.docId}`]: { apiKey: "ลับ" },
    "beamMerchantIndex/m1": { shopId: SHOP_A.docId },
    "beamBoltConnections/c1": { shopId: SHOP_A.docId },
    [`shop/${SHOP_A.docId}/meta/paymentGateway`]: { ntt: { password: "ลับ" } },
    "userMetadata/u1": { x: 1 },
    "masterStock/m1": { x: 1 },
  };
}

export async function makeEnv(projectId) {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
  return initializeTestEnvironment({ projectId, firestore: { host, port: Number(port), rules: readFileSync(RULES_FILE, "utf8") } });
}

export async function seedAll(env) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    const all = { ...globalSeed(), ...shopSeed(SHOP_A), ...shopSeed(SHOP_L), ...shopSeed(SHOP_B) };
    await Promise.all(Object.entries(all).map(([p, d]) => setDoc(doc(db, p), d)));
  });
}

export const as = (env, u, claims = {}) => env.authenticatedContext(u, claims).firestore();
export const asShared = (env) => env.authenticatedContext(U.shared, { email: SHARED_EMAIL }).firestore();
export const anon = (env) => env.unauthenticatedContext().firestore();
