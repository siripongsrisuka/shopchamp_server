// firestore.watcher.test.mjs — เลน watcher อ่านอย่างเดียว + เลนทีมงานเดิมของแอปเก่ายังทำงาน (DEV-0001 watcher · Pack เคาะ 2026-11-07 ข้อ 6)
// พิสูจน์ 2 ทิศ: รันกับ rules ก่อนแก้ (RULES_FILE=<rules ที่ HEAD ก่อน watcher>) ⇒ กลุ่ม [WATCHER ALLOW] ต้องแดง (ไม่มีเลน watcher)
import { test, before, beforeEach, after } from "node:test";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, query, where, limit } from "firebase/firestore";
import { makeEnv, seedAll, as, U, SHOP_A, SHOP_B, SHOP_L, FR, FR_B } from "./fixtures.mjs";

let env;
before(async () => { env = await makeEnv("demo-shopchamp-rules-watcher"); });
beforeEach(async () => { await seedAll(env); });
after(async () => { await env?.cleanup(); });

const w = () => as(env, U.watcher);
const setRoster = (data) => env.withSecurityRulesDisabled(async (c) => {
  const ref = doc(c.firestore(), "watcher", "roster");
  if (data === null) await deleteDoc(ref); else await setDoc(ref, data);
});

// collection ของร้าน: [ชื่อ, id ของร้าน B]
const SCOPED = [
  ["stock", "stockB1"], ["notification", "notiB1"], ["member", "memberB1"], ["shift", `${SHOP_B.docId}-shift`], ["importProduct", "impB1"],
  ["promotion", "proB1"], ["checkIn", `${SHOP_B.shopId}${U.staffB}`], ["expense", "expB1"], ["expenseReport", "repB1"], ["memberList", `Q${SHOP_B.shopId}`],
  ["supplier", "supB1"], ["shiftHistory", "shB1"], ["hardwareOrder", "hoB1"], ["imageOrder", "ioB1"], ["packageOrder", "poB1"], ["stockOrder", "soB1"],
  ["requisition", "reqB1"], ["stockReport", "srepB1"], ["bill", "billB1"], ["paidHistory", "paidB1"], ["checkInHistory", "chkB1"], ["stockLink", "linkB1"],
];

// ---------------- watcher อ่านได้ทุกร้าน ----------------
for (const [c, idB] of SCOPED) {
  test(`[WATCHER ALLOW] get ${c} ของร้าน B`, async () => { await assertSucceeds(getDoc(doc(w(), c, idB))); });
  test(`[WATCHER ALLOW] list ${c} ร้าน B (realtime ของแอปใหม่)`, async () => { await assertSucceeds(getDocs(query(collection(w(), c), where("shopId", "==", SHOP_B.shopId)))); });
  test(`[WATCHER DENY] สร้าง ${c} ใส่ร้าน B`, async () => { await assertFails(addDoc(collection(w(), c), { shopId: SHOP_B.shopId, x: 1 })); });
  test(`[WATCHER DENY] แก้ ${c} ของร้าน B`, async () => { await assertFails(updateDoc(doc(w(), c, idB), { x: 2 })); });
  test(`[WATCHER DENY] ลบ ${c} ของร้าน B`, async () => { await assertFails(deleteDoc(doc(w(), c, idB))); });
}
test("[WATCHER ALLOW] list stock ร้านรุ่นเก่า L (field shopId = uid เจ้าของ)", async () => { await assertSucceeds(getDocs(query(collection(w(), "stock"), where("shopId", "==", SHOP_L.shopId)))); });
for (const [c, key] of [["billId", SHOP_B.docId], ["billDayId", SHOP_B.docId], ["taxId", SHOP_B.shopId]]) {
  test(`[WATCHER ALLOW] อ่าน ${c} ของร้าน B`, async () => { await assertSucceeds(getDoc(doc(w(), c, key))); });
  test(`[WATCHER DENY] เขียน ${c} ของร้าน B`, async () => { await assertFails(setDoc(doc(w(), c, key), { month: 1, receipts: 999 })); });
}
test("[WATCHER ALLOW] ใบรับเงิน pgWebhook ร้าน B get/list", async () => {
  await assertSucceeds(getDoc(doc(w(), "pgWebhook", "pgB1")));
  await assertSucceeds(getDocs(query(collection(w(), "pgWebhook"), where("shopId", "==", SHOP_B.shopId))));
});
test("[WATCHER DENY] เขียน pgWebhook", async () => { await assertFails(updateDoc(doc(w(), "pgWebhook", "pgB1"), { process: "success" })); });
test("[WATCHER ALLOW] แฟรนไชส์ที่ไม่ได้อยู่ get · list · คลัง", async () => {
  await assertSucceeds(getDoc(doc(w(), "franchise", FR_B)));
  await assertSucceeds(getDocs(query(collection(w(), "franchise"), limit(5))));
  await assertSucceeds(getDoc(doc(w(), "warehouseItem", "whB")));
  await assertSucceeds(getDocs(query(collection(w(), "warehouseItem"), where("franchiseId", "==", FR_B))));
});
test("[WATCHER DENY] เขียนแฟรนไชส์ · คลัง · ร้าน (รวมผูก franchiseId) · profile คนอื่น", async () => {
  await assertFails(updateDoc(doc(w(), "franchise", FR_B), { name: "x" }));
  await assertFails(updateDoc(doc(w(), "warehouseItem", "whB"), { stock: 9 }));
  await assertFails(addDoc(collection(w(), "warehouseItem"), { franchiseId: FR_B, name: "x" }));
  await assertFails(updateDoc(doc(w(), "shop", SHOP_B.docId), { name: "แก้" }));
  await assertFails(updateDoc(doc(w(), "shop", SHOP_B.docId), { franchiseId: FR }));
  await assertFails(deleteDoc(doc(w(), "shop", SHOP_B.docId)));
  await assertFails(updateDoc(doc(w(), "profile", U.ownerB), { name: "x" }));
  await assertFails(updateDoc(doc(w(), "admin", "adminConfig"), { admin: [U.watcher] }));
});

// ---------------- ทะเบียนเอง: client แตะไม่ได้ทุกคน ----------------
for (const [who, u] of [["watcher", U.watcher], ["ทีมงานเลนเก่า (adminConfig)", U.team], ["ทีมงานเว็บเลนเก่า (admin/admin)", U.teamWeb], ["เจ้าของร้าน", U.ownerA], ["คนนอก", U.outsider]]) {
  test(`[ROSTER DENY] ${who} อ่าน watcher/roster`, async () => { await assertFails(getDoc(doc(as(env, u), "watcher", "roster"))); });
  test(`[ROSTER DENY] ${who} เขียน watcher/roster (ใส่ตัวเอง)`, async () => { await assertFails(setDoc(doc(as(env, u), "watcher", "roster"), { uids: [u], rootUids: [u] })); });
  test(`[ROSTER DENY] ${who} อ่าน/เขียน watcherWriteLog`, async () => {
    await assertFails(getDoc(doc(as(env, u), "watcherWriteLog", "w1")));
    await assertFails(addDoc(collection(as(env, u), "watcherWriteLog"), { uid: u }));
  });
}

// ---------------- fail-closed ----------------
for (const [label, data] of [["ไม่มี doc", null], ["uids ว่าง", { uids: [] }], ["uids ไม่ใช่ list", { uids: U.watcher }], ["ไม่มีช่อง uids", { rootUids: [U.watcher] }]]) {
  test(`[WATCHER DENY] ทะเบียน${label} → watcher อ่านร้าน B ไม่ได้`, async () => {
    await setRoster(data);
    await assertFails(getDoc(doc(w(), "stock", "stockB1")));
    await assertFails(getDocs(query(collection(w(), "bill"), where("shopId", "==", SHOP_B.shopId))));
    await assertFails(getDoc(doc(w(), "billId", SHOP_B.docId)));
  });
}
test("[WATCHER DENY] คนที่อยู่แค่ rootUids แต่ไม่อยู่ใน uids → อ่านไม่ได้ (root ⊆ watcher)", async () => {
  await setRoster({ uids: [U.outsider], rootUids: [U.watcher] });
  await assertFails(getDoc(doc(w(), "stock", "stockB1")));
});

// ---------------- เลนเก่าของแอปเก่ายังทำงาน (staffTeam = adminConfig / admin/admin) ----------------
test("[OLD LANE ALLOW] ทีมงานใน adminConfig อ่าน+เขียนร้าน B ได้เหมือนเดิม (แอปเก่าไม่พัง)", async () => {
  const t = as(env, U.team);
  await assertSucceeds(getDoc(doc(t, "stock", "stockB1")));
  await assertSucceeds(updateDoc(doc(t, "stock", "stockB1"), { stock: 7 }));
  await assertSucceeds(updateDoc(doc(t, "shop", SHOP_B.docId), { name: "ทีมงานแก้" }));
  await assertSucceeds(setDoc(doc(t, "billId", SHOP_B.docId), { month: 11, receipts: 11 }));
  await assertSucceeds(getDoc(doc(t, "admin", "adminConfig")));
});
test("[OLD LANE ALLOW] ทีมงานเว็บใน admin/admin.value อ่าน+เขียนร้าน B ได้เหมือนเดิม", async () => {
  const t = as(env, U.teamWeb);
  await assertSucceeds(getDocs(query(collection(t, "bill"), where("shopId", "==", SHOP_B.shopId))));
  await assertSucceeds(updateDoc(doc(t, "member", "memberB1"), { point: 11 }));
});
test("[OLD LANE] ทะเบียน watcher ว่าง ไม่กระทบเลนเก่า", async () => {
  await setRoster(null);
  await assertSucceeds(updateDoc(doc(as(env, U.team), "stock", "stockB1"), { stock: 8 }));
});
test("[WATCHER] watcher ไม่ได้สิทธิ์เลนเก่า: ไม่อยู่ใน adminConfig ⇒ collection หลังบ้าน (adjustStock) อ่านไม่ได้", async () => {
  await assertFails(getDocs(query(collection(w(), "adjustStock"), limit(1))));
});
