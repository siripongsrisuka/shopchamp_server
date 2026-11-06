// backfill.test.mjs — ดัชนีร้านรุ่นเก่า: ก่อนรันสคริปต์ พนักงานร้านเก่าถูกปัด · หลังรันผ่าน · ร้านที่ชนถูกข้าม (DEV-0001 ก้อน 6)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDocs, query, collection, where } from "firebase/firestore";
import { makeEnv, as, U, SHOP_L, shopDoc } from "./fixtures.mjs";

const require = createRequire(import.meta.url);
const admin = require("../functions/node_modules/firebase-admin");
const { buildAliases } = require("./backfill-shop-alias.cjs");
const PROJECT = "demo-shopchamp-rules-backfill";
let env; let adb;

before(async () => {
  env = await makeEnv(PROJECT);
  await env.clearFirestore();
  const app = admin.initializeApp({ projectId: PROJECT }, "backfill-test");
  adb = app.firestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, "shop", SHOP_L.docId), shopDoc(SHOP_L));
    // เจ้าของคนเดียว 2 ร้านแบบเก่า (field เดียวกัน)
    await setDoc(doc(db, "shop", "legacyDocSecondShop1"), { shopId: SHOP_L.shopId, humanResource: [{ id: U.ownerL }, { id: U.staffB }] });
    // ร้านปกติ
    await setDoc(doc(db, "shop", "normalShop000000001"), { shopId: "normalShop000000001", humanResource: [{ id: U.ownerA }] });
    // field ชี้ doc id ร้านอื่น = ต้องข้าม
    await setDoc(doc(db, "shop", "attackerShop0000001"), { shopId: "normalShop000000001", humanResource: [{ id: U.outsider }] });
    await setDoc(doc(db, "stock", "s1"), { shopId: SHOP_L.shopId, stock: 1 });
  });
});
after(async () => { await env?.cleanup(); await admin.app("backfill-test").delete(); });

const listL = (u) => getDocs(query(collection(as(env, u), "stock"), where("shopId", "==", SHOP_L.shopId)));

test("ก่อน backfill: พนักงานร้านเก่าถูกปัด · เจ้าของผ่าน (key == uid)", async () => {
  await assertFails(listL(U.staffL));
  await assertSucceeds(listL(U.ownerL));
});
test("backfill: ทำดัชนีร้านเก่า · ข้ามร้านที่ชน doc id", async () => {
  const r = await buildAliases(adb, { write: true, pageSize: 2, log: () => {} });
  assert.equal(r.scanned, 4);
  assert.deepEqual(r.aliases, [{ key: SHOP_L.shopId, docIds: ["legacyDocSecondShop1", SHOP_L.docId].sort() }]);
  assert.deepEqual(r.skipped.map((s) => s.key), ["normalShop000000001"]);
  assert.equal(r.multi, 1);
});
test("หลัง backfill: พนักงานร้านเก่าทั้ง 2 ร้านผ่าน · คนนอกยังถูกปัด", async () => {
  await assertSucceeds(listL(U.staffL));
  await assertSucceeds(listL(U.staffB)); // พนักงานของร้านที่ 2 ที่ถือ field เดียวกัน
  await assertFails(listL(U.outsider));
});
test("ร้านที่ field ชี้ doc id ร้านอื่นไม่ได้สิทธิ์ร้านนั้น", async () => {
  await assertFails(getDocs(query(collection(as(env, U.outsider), "stock"), where("shopId", "==", "normalShop000000001"))));
});
