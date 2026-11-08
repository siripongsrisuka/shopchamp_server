// firestore.stockJournal.test.mjs — สมุดเคลื่อนไหวสต๊อกรายวัน (DEV-0007) = server เท่านั้น · client แตะไม่ได้ทุกคน รวมเจ้าของร้านและพนักงานของร้านนั้น
//   พิสูจน์ 2 ทิศ: RULES_FILE=../rules-rollback/firestore.rules.before-chunk6 (ตัวเปิดแบบที่ live) ต้องแดง · firestore.rules ต้องเขียว
import { test, before, beforeEach, after } from "node:test";
import { assertFails } from "@firebase/rules-unit-testing";
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, increment } from "firebase/firestore";
import { makeEnv, seedAll, as, U, SHOP_A } from "./fixtures.mjs";

const ID = `${SHOP_A.docId}_20261110_sale_0`;
let env;
before(async () => { env = await makeEnv("demo-shopchamp-rules-stockjournal"); });
beforeEach(async () => {
  await seedAll(env);
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), "stockJournal", ID), { shopId: SHOP_A.docId, day: "20261110", kind: "sale", part: 0, qty: { p1: -2 }, events: 1 });
  });
});
after(async () => { await env?.cleanup(); });

const WHO = [["เจ้าของร้าน", U.ownerA], ["พนักงานร้าน", U.staffA], ["เจ้าของร้านอื่น", U.ownerB], ["คนนอก", U.outsider]];
for (const [who, u] of WHO) {
  test(`[STOCKJOURNAL DENY] ${who} อ่าน doc สมุด`, async () => { await assertFails(getDoc(doc(as(env, u), "stockJournal", ID))); });
  test(`[STOCKJOURNAL DENY] ${who} query สมุดของร้าน`, async () => {
    await assertFails(getDocs(query(collection(as(env, u), "stockJournal"), where("shopId", "==", SHOP_A.docId))));
  });
  test(`[STOCKJOURNAL DENY] ${who} แก้/สร้าง/ลบ สมุด`, async () => {
    await assertFails(updateDoc(doc(as(env, u), "stockJournal", ID), { "qty.p1": increment(100) }));
    await assertFails(setDoc(doc(as(env, u), "stockJournal", `${SHOP_A.docId}_20261111_sale_0`), { shopId: SHOP_A.docId, qty: {} }));
    await assertFails(deleteDoc(doc(as(env, u), "stockJournal", ID)));
  });
}
test("[STOCKJOURNAL DENY] ไม่ login อ่าน", async () => { await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "stockJournal", ID))); });
