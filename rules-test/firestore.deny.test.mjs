// firestore.deny.test.mjs — ข้ามร้าน · ไม่ login · ของ server · collection ใหม่ · ช่องที่เคยเปิด ต้องถูกปัด (DEV-0001 ก้อน 6)
// พิสูจน์ 2 ทิศ: รันกับ rules เก่า (RULES_FILE=../rules-rollback/firestore.rules.before-chunk6) ต้องแดงเกือบทั้งไฟล์
import { test, before, beforeEach, after } from "node:test";
import { assertFails } from "@firebase/rules-unit-testing";
import {
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, query, where, runTransaction, writeBatch, limit,
} from "firebase/firestore";
import { makeEnv, seedAll, as, asShared, anon, U, SHOP_A, SHOP_L, SHOP_B, FR, FR_B } from "./fixtures.mjs";
import { SHOP_SCENARIOS } from "./scenarios.mjs";

let env;
before(async () => { env = await makeEnv("demo-shopchamp-rules-deny"); });
beforeEach(async () => { await seedAll(env); });
after(async () => { await env?.cleanup(); });

// collection ของร้าน: [ชื่อ, id ของ doc ร้าน B, id ของ doc ร้าน A, get รายใบปัดไหม]
const SCOPED = [
  ["stock", "stockB1", "stockA1", true], ["notification", "notiB1", "notiA1", true], ["member", "memberB1", "memberA1", true],
  ["shift", `${SHOP_B.docId}-shift`, `${SHOP_A.docId}-shift`, true], ["importProduct", "impB1", "impA1", true],
  ["promotion", "proB1", "proA1", true], ["checkIn", `${SHOP_B.shopId}${U.staffB}`, `${SHOP_A.shopId}${U.staffA}`, true],
  ["expense", "expB1", "expA1", true], ["expenseReport", "repB1", "repA1", true], ["memberList", `Q${SHOP_B.shopId}`, `Q${SHOP_A.shopId}`, true],
  ["supplier", "supB1", "supA1", true], ["shiftHistory", "shB1", "shA1", true], ["hardwareOrder", "hoB1", "hoA1", true],
  ["imageOrder", "ioB1", "ioA1", true], ["packageOrder", "poB1", "poA1", true], ["stockOrder", "soB1", "soA1", true],
  ["requisition", "reqB1", "reqA1", true], ["stockReport", "srepB1", "srepA1", true], ["bill", "billB1", "billA1", true],
  ["paidHistory", "paidB1", "paidA1", true], ["checkInHistory", "chkB1", "chkA1", true], ["stockLink", "linkB1", "linkA1", true],
  ["priceTag", "tagB1", "tagA1", false], ["uploadProduct", "upB1", "upA1", false],
];
const ATTACKERS = [["พนักงาน A", U.staffA], ["พนักงานร้านเก่า L", U.staffL], ["เจ้าของ A", U.ownerA]];

for (const [c, idB, idA, getDenied] of SCOPED) {
  for (const [who, u] of ATTACKERS) {
    const db = () => as(env, u);
    if (getDenied) test(`[DENY] ${who} get ${c} ของร้าน B`, async () => { await assertFails(getDoc(doc(db(), c, idB))); });
    test(`[DENY] ${who} list ${c} ร้าน B`, async () => { await assertFails(getDocs(query(collection(db(), c), where("shopId", "==", SHOP_B.shopId)))); });
    test(`[DENY] ${who} สร้าง ${c} ใส่ร้าน B`, async () => { await assertFails(addDoc(collection(db(), c), { shopId: SHOP_B.shopId, x: 1 })); });
    test(`[DENY] ${who} แก้ ${c} ของร้าน B`, async () => { await assertFails(updateDoc(doc(db(), c, idB), { x: 2 })); });
    test(`[DENY] ${who} ลบ ${c} ของร้าน B`, async () => { await assertFails(deleteDoc(doc(db(), c, idB))); });
  }
  test(`[DENY] พนักงาน A ย้าย ${c} ของตัวเองไปร้าน B`, async () => { await assertFails(updateDoc(doc(as(env, U.staffA), c, idA), { shopId: SHOP_B.shopId })); });
  test(`[DENY] พนักงาน B อ่าน ${c} ของร้านเก่า L (ผ่านดัชนี)`, async () => { await assertFails(getDocs(query(collection(as(env, U.staffB), c), where("shopId", "==", SHOP_L.shopId)))); });
  test(`[DENY] ไม่ login list ${c}`, async () => { await assertFails(getDocs(query(collection(anon(env), c), where("shopId", "==", SHOP_A.shopId)))); });
  test(`[DENY] ไม่ login get ${c}`, async () => { await assertFails(getDoc(doc(anon(env), c, idA))); });
  test(`[DENY] ไม่ login สร้าง ${c}`, async () => { await assertFails(addDoc(collection(anon(env), c), { shopId: SHOP_A.shopId })); });
  test(`[DENY] คน login ที่ไม่อยู่ร้านไหน list ${c} ร้าน A`, async () => { await assertFails(getDocs(query(collection(as(env, U.outsider), c), where("shopId", "==", SHOP_A.shopId)))); });
}
// list ทั้ง collection โดยไม่กรองร้าน
for (const c of ["stock", "bill", "member", "shift", "notification", "paidHistory", "checkInHistory", "memberList"]) {
  test(`[DENY] พนักงาน A list ${c} ทั้งฐาน`, async () => { await assertFails(getDocs(query(collection(as(env, U.staffA), c), limit(5)))); });
}

// ---------------- ตัวนับของร้าน (doc id = ร้าน) ----------------
for (const [c, keyB] of [["billId", SHOP_B.docId], ["billDayId", SHOP_B.docId], ["taxId", SHOP_B.shopId], ["billId", SHOP_L.docId], ["taxId", SHOP_L.shopId]]) {
  test(`[DENY] พนักงาน A อ่าน ${c}/${keyB.slice(0, 6)}…`, async () => { await assertFails(getDoc(doc(as(env, U.staffA), c, keyB))); });
  test(`[DENY] พนักงาน A เขียน ${c}/${keyB.slice(0, 6)}…`, async () => { await assertFails(setDoc(doc(as(env, U.staffA), c, keyB), { month: 1, receipts: 999 })); });
  test(`[DENY] ไม่ login อ่าน ${c}`, async () => { await assertFails(getDoc(doc(anon(env), c, keyB))); });
}

// ---------------- ทางผ่านสมาชิก/เวลาเข้างาน ----------------
test("[DENY] พนักงาน A ดูบิลของสมาชิกร้าน B", async () => { await assertFails(getDocs(query(collection(as(env, U.staffA), "bill"), where("member.id", "==", "memberB1")))); });
test("[DENY] พนักงาน A ดูประวัติชำระของสมาชิกร้าน B", async () => { await assertFails(getDocs(query(collection(as(env, U.staffA), "paidHistory"), where("memberId", "==", "memberB1")))); });
test("[DENY] พนักงาน A ดูเวลาเข้างานของพนักงาน B", async () => { await assertFails(getDocs(query(collection(as(env, U.staffA), "checkInHistory"), where("id", "==", SHOP_B.shopId + U.staffB)))); });
test("[DENY] พนักงานคนที่ 81 (index 80 · เกินเพดาน 80 ช่อง)", async () => { await assertFails(getDocs(query(collection(as(env, U.staffA100), "stock"), where("shopId", "==", SHOP_A.shopId)))); });

// ---------------- ขายข้ามร้าน ----------------
test("[DENY] พนักงาน A ขาย (transaction ทั้งชุด) ลงร้าน B", async () => { await assertFails(SHOP_SCENARIOS["sale-tx-month"](as(env, U.staffA), SHOP_B)); });
test("[DENY] พนักงาน A ขายร้าน A แต่ตัดสต็อกร้าน B ปนมา", async () => {
  const db = as(env, U.staffA);
  await assertFails(runTransaction(db, async (t) => {
    const r = doc(db, "stock", "stockB1"); const s = await t.get(r).catch(() => null); void s;
    t.update(r, { stock: 0 });
    t.set(doc(collection(db, "bill")), { shopId: SHOP_A.shopId, net: 1 });
  }));
});
test("[DENY] receiptGuard ผูกกับบิลร้าน B", async () => {
  const db = as(env, U.staffA);
  await assertFails(setDoc(doc(db, "receiptGuard", "uuid-x"), { createdAt: new Date(), usedBy: "billB1" }));
});
test("[DENY] receiptGuard ช่องเกิน", async () => {
  const db = as(env, U.staffA);
  await assertFails(runTransaction(db, async (t) => {
    const b = doc(collection(db, "bill")); t.set(b, { shopId: SHOP_A.shopId });
    t.set(doc(db, "receiptGuard", "uuid-y"), { createdAt: new Date(), usedBy: b.id, extra: 1 });
  }));
});
test("[DENY] แก้ receiptGuard ที่มีอยู่", async () => { await assertFails(updateDoc(doc(as(env, U.ownerB), "receiptGuard", "guardB"), { usedBy: "x" })); });
test("[DENY] ลบ receiptGuard", async () => { await assertFails(deleteDoc(doc(as(env, U.ownerB), "receiptGuard", "guardB"))); });

// ---------------- shop ----------------
test("[DENY] พนักงาน A แก้ doc ร้าน B", async () => { await assertFails(updateDoc(doc(as(env, U.staffA), "shop", SHOP_B.docId), { name: "โดนแก้" })); });
test("[DENY] พนักงาน A ใส่ตัวเองเข้า humanResource ร้าน B", async () => { await assertFails(updateDoc(doc(as(env, U.staffA), "shop", SHOP_B.docId), { humanResource: [{ id: U.staffA, status: "active" }] })); });
test("[DENY] พนักงาน B แก้ doc ร้านเก่า L", async () => { await assertFails(updateDoc(doc(as(env, U.staffB), "shop", SHOP_L.docId), { name: "x" })); });
test("[DENY] เปลี่ยน field shopId ของร้านตัวเอง", async () => { await assertFails(updateDoc(doc(as(env, U.ownerA), "shop", SHOP_A.docId), { shopId: SHOP_B.shopId })); });
test("[DENY] สร้าง shop/{uid เจ้าของร้านเก่า} เพื่อครอบร้าน L", async () => {
  await assertFails(setDoc(doc(as(env, U.outsider), "shop", SHOP_L.shopId), { shopId: SHOP_L.shopId, humanResource: [{ id: U.outsider }] }));
});
test("[DENY] สร้าง shop/{uid ที่ไม่มีดัชนี} (doc id ไม่ใช่ auto-id 20 ตัว)", async () => {
  const victim = U.staffB;
  await assertFails(setDoc(doc(as(env, U.outsider), "shop", victim), { shopId: victim, humanResource: [{ id: U.outsider }] }));
});
test("[DENY] สร้างร้านที่ shopId ≠ doc id", async () => {
  const db = as(env, U.outsider); const r = doc(collection(db, "shop"));
  await assertFails(setDoc(r, { shopId: SHOP_B.shopId, humanResource: [{ id: U.outsider }] }));
});
test("[DENY] สร้างร้านที่ตัวเองไม่อยู่ใน humanResource", async () => {
  const db = as(env, U.outsider); const r = doc(collection(db, "shop"));
  await assertFails(setDoc(r, { shopId: r.id, humanResource: [{ id: U.ownerB }] }));
});
test("[DENY] แฟรนไชส์ผูกสาขาแต่แก้ช่องอื่นพ่วง", async () => { await assertFails(updateDoc(doc(as(env, U.franchise), "shop", SHOP_B.docId), { franchiseId: FR, name: "x" })); });
test("[DENY] ผูกสาขาเข้าแฟรนไชส์ที่ตัวเองไม่อยู่", async () => { await assertFails(updateDoc(doc(as(env, U.franchise), "shop", SHOP_B.docId), { franchiseId: FR_B })); });
test("[DENY] บัญชีกลางแก้ช่องอื่นนอก smartCategory", async () => { await assertFails(updateDoc(doc(asShared(env), "shop", SHOP_B.docId), { humanResource: [] })); });
test("[DENY] บัญชีกลางแก้สต็อกร้านอื่น", async () => { await assertFails(updateDoc(doc(asShared(env), "stock", "stockB1"), { stock: 0 })); });
test("[DENY] บัญชีกลางอ่านบิลร้านอื่น", async () => { await assertFails(getDoc(doc(asShared(env), "bill", "billB1"))); });
test("[DENY] ลบร้าน (ไม่ใช่ทีมงาน)", async () => { await assertFails(deleteDoc(doc(as(env, U.ownerA), "shop", SHOP_A.docId))); });
test("[DENY] ไม่ login อ่าน shop", async () => { await assertFails(getDoc(doc(anon(env), "shop", SHOP_A.docId))); });

// ---------------- profile admin ตัวนับ ----------------
test("[DENY] แก้ profile คนอื่น", async () => { await assertFails(updateDoc(doc(as(env, U.staffA), "profile", U.ownerB), { currentLogin: { shopId: SHOP_A.shopId } })); });
test("[DENY] profile.add ได้ doc id สุ่ม (profileSlice.js:30 ไม่มีผู้เรียก)", async () => { await assertFails(addDoc(collection(as(env, U.staffA), "profile"), { name: "x" })); });
test("[DENY] ไม่ login อ่าน profile", async () => { await assertFails(getDoc(doc(anon(env), "profile", U.staffA))); });
test("[DENY] ใส่ตัวเองเข้ารายชื่อทีมงาน admin/adminConfig", async () => { await assertFails(updateDoc(doc(as(env, U.ownerA), "admin", "adminConfig"), { admin: [U.ownerA] })); });
test("[DENY] ใส่ตัวเองเข้ารายชื่อทีมงานเว็บ admin/admin", async () => { await assertFails(updateDoc(doc(as(env, U.ownerA), "admin", "admin"), { value: [U.ownerA] })); });
test("[DENY] แก้ admin/package (หน้าทดสอบ ไม่ใช่ทีมงาน)", async () => { await assertFails(updateDoc(doc(as(env, U.ownerA), "admin", "package"), { payment: [] })); });
test("[DENY] ตัวนับคำสั่งซื้อกระโดด +2", async () => { await assertFails(updateDoc(doc(as(env, U.ownerA), "admin", "packageNumber"), { value: 7 })); });
test("[DENY] ตัวนับคำสั่งซื้อแก้ช่องอื่น", async () => { await assertFails(updateDoc(doc(as(env, U.ownerA), "admin", "packageNumber"), { value: 6, x: 1 })); });
test("[DENY] สร้าง doc ใหม่ใน admin", async () => { await assertFails(setDoc(doc(as(env, U.ownerA), "admin", "newDoc"), { x: 1 })); });
test("[DENY] เลขร้านกระโดด", async () => { await assertFails(updateDoc(doc(as(env, U.ownerA), "shopchamShopId", "numOfStore"), { total: 1 })); });
test("[DENY] ไม่ login อ่าน admin", async () => { await assertFails(getDoc(doc(anon(env), "admin", "adminConfig"))); });

// ---------------- deletedUser loginByScan ----------------
test("[DENY] ส่งคำขอลบบัญชีในนามคนอื่น", async () => { await assertFails(addDoc(collection(as(env, U.staffA), "deletedUser"), { uid: U.ownerB, isDeleteSuccess: true })); });
test("[DENY] แก้คำขอลบบัญชีของคนอื่น", async () => { await assertFails(updateDoc(doc(as(env, U.staffA), "deletedUser", "delB"), { isDeleteSuccess: false })); });
test("[DENY] อ่าน deletedUser", async () => { await assertFails(getDoc(doc(as(env, U.staffA), "deletedUser", "del1"))); });
test("[DENY] loginByScan เขียน uid ของคนอื่น (สวมรอยเข้าเว็บ)", async () => { await assertFails(updateDoc(doc(as(env, U.staffA), "loginByScan", "scan1"), { uid: U.ownerB })); });
test("[DENY] loginByScan แก้ช่องอื่น", async () => { await assertFails(updateDoc(doc(as(env, U.staffA), "loginByScan", "scan1"), { uid: U.staffA, docId: "x" })); });
test("[DENY] ไม่ login สร้าง loginByScan", async () => { await assertFails(setDoc(doc(anon(env), "loginByScan", "z"), { uid: "", docId: "z" })); });

// ---------------- แฟรนไชส์ ----------------
test("[DENY] อ่านแฟรนไชส์ที่ตัวเองไม่อยู่", async () => { await assertFails(getDoc(doc(as(env, U.franchise), "franchise", FR_B))); });
test("[DENY] แก้แฟรนไชส์ที่ตัวเองไม่อยู่", async () => { await assertFails(updateDoc(doc(as(env, U.franchise), "franchise", FR_B), { humanResource: [U.franchise] })); });
test("[DENY] list แฟรนไชส์ทั้งหมด (ไม่ใช่ทีมงาน)", async () => { await assertFails(getDocs(collection(as(env, U.franchise), "franchise"))); });
test("[DENY] ลบแฟรนไชส์", async () => { await assertFails(deleteDoc(doc(as(env, U.franchise), "franchise", FR))); });
test("[DENY] อ่านคลังแฟรนไชส์อื่น", async () => { await assertFails(getDocs(query(collection(as(env, U.franchise), "warehouseItem"), where("franchiseId", "==", FR_B)))); });
test("[DENY] แก้คลังแฟรนไชส์อื่น", async () => { await assertFails(updateDoc(doc(as(env, U.franchise), "warehouseItem", "whB"), { stock: 9 })); });
test("[DENY] ย้ายของคลังไปแฟรนไชส์อื่น", async () => { await assertFails(updateDoc(doc(as(env, U.franchise), "warehouseItem", "wh1"), { franchiseId: FR_B })); });
test("[DENY] แฟรนไชส์อื่นอ่านบิลสาขาของ F1", async () => { await assertFails(getDocs(query(collection(as(env, U.franchiseB), "bill"), where("franchiseId", "==", FR)))); });
test("[DENY] แฟรนไชส์อื่นสร้าง stockLink ใส่ F1", async () => { await assertFails(addDoc(collection(as(env, U.franchiseB), "stockLink"), { franchiseId: FR })); });
test("[DENY] พนักงาน A อ่านคลังแฟรนไชส์", async () => { await assertFails(getDoc(doc(as(env, U.staffA), "warehouseItem", "wh1"))); });

// ---------------- pgWebhook: client เขียนไม่ได้ แม้ร้านตัวเองและทีมงาน ----------------
for (const [who, u] of [["เจ้าของ A", U.ownerA], ["ทีมงาน", U.team]]) {
  test(`[DENY] ${who} สร้าง pgWebhook (CheckoutScreen.js:247)`, async () => { await assertFails(addDoc(collection(as(env, u), "pgWebhook"), { shopId: SHOP_A.shopId, process: "request" })); });
  test(`[DENY] ${who} ตั้ง pgWebhook เป็น success เอง`, async () => { await assertFails(updateDoc(doc(as(env, u), "pgWebhook", "pgA1"), { process: "success" })); });
  test(`[DENY] ${who} ลบ pgWebhook`, async () => { await assertFails(deleteDoc(doc(as(env, u), "pgWebhook", "pgA1"))); });
}
test("[DENY] พนักงาน A อ่าน pgWebhook ร้าน B", async () => { await assertFails(getDoc(doc(as(env, U.staffA), "pgWebhook", "pgB1"))); });

// ---------------- ของ server · collection ใหม่ · subcollection ----------------
const SERVER_ONLY = ["gatewayCreds", "gatewayStations", "beamMerchantCreds", "beamMerchantIndex", "beamBoltConnections", "shopAlias",
  "userMetadata", "masterStock", "masterSectionStock", "order", "replyControl", "memberProvider", "testCron", "cashierCodeGuard", "lineSecrets", "collectionThatDoesNotExistYet"];
const SERVER_DOC = { gatewayCreds: SHOP_A.docId, gatewayStations: SHOP_A.docId, beamMerchantCreds: SHOP_A.docId, beamMerchantIndex: "m1", beamBoltConnections: "c1", shopAlias: SHOP_L.shopId, userMetadata: "u1", masterStock: "m1", cashierCodeGuard: `${SHOP_A.docId}_u1`, lineSecrets: SHOP_A.docId };
for (const c of SERVER_ONLY) {
  for (const [who, db] of [["เจ้าของ A", () => as(env, U.ownerA)], ["ทีมงาน", () => as(env, U.team)], ["ไม่ login", () => anon(env)]]) {
    const id = SERVER_DOC[c] || "x1";
    test(`[DENY] ${who} get ${c}`, async () => { await assertFails(getDoc(doc(db(), c, id))); });
    test(`[DENY] ${who} list ${c}`, async () => { await assertFails(getDocs(query(collection(db(), c), limit(1)))); });
    test(`[DENY] ${who} เขียน ${c}`, async () => { await assertFails(setDoc(doc(db(), c, id), { shopId: SHOP_A.shopId, docIds: [SHOP_A.docId] })); });
    test(`[DENY] ${who} ลบ ${c}`, async () => { await assertFails(deleteDoc(doc(db(), c, id))); });
  }
}
for (const [who, db] of [["เจ้าของ A", () => as(env, U.ownerA)], ["ทีมงาน", () => as(env, U.team)]]) {
  test(`[DENY] ${who} อ่าน shop/A/meta/paymentGateway`, async () => { await assertFails(getDoc(doc(db(), "shop", SHOP_A.docId, "meta", "paymentGateway"))); });
  test(`[DENY] ${who} เขียน shop/A/meta/paymentGateway`, async () => { await assertFails(setDoc(doc(db(), "shop", SHOP_A.docId, "meta", "paymentGateway"), { x: 1 })); });
  test(`[DENY] ${who} subcollection ใหม่ใต้ bill`, async () => { await assertFails(setDoc(doc(db(), "bill", "billA1", "items", "i1"), { x: 1 })); });
}
// ทีมงานไม่ใช่ทางลัดสร้างดัชนีร้านเก่า
test("[DENY] สร้าง shopAlias ของตัวเองให้ชี้ร้าน B", async () => { await assertFails(setDoc(doc(as(env, U.ownerA), "shopAlias", U.ownerA), { docIds: [SHOP_B.docId] })); });
// batch ที่มีคำสั่งเดียวผิด = ทั้งชุดตก
test("[DENY] batch ร้าน A + 1 คำสั่งข้ามร้าน", async () => {
  const db = as(env, U.staffA); const b = writeBatch(db);
  b.update(doc(db, "stock", "stockA1"), { stock: 1 }); b.update(doc(db, "stock", "stockB1"), { stock: 1 });
  await assertFails(b.commit());
});
