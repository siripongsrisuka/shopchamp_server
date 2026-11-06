// firestore.allow.test.mjs — ทุกจุดเรียกของ client รุ่นเดิมต้องผ่าน (DEV-0001 ก้อน 6 · เกณฑ์ "เขียนร้านตัวเองผ่าน 100%")
// ตารางจุดเรียก → เทส = sites.mjs · รันกับ rules เก่าก็ต้องเขียว (rules เก่าเปิดทุกอย่างให้ผู้ login)
import { test, before, beforeEach, after } from "node:test";
import { assertSucceeds } from "@firebase/rules-unit-testing";
import { makeEnv, seedAll, as, asShared, U, SHOP_A, SHOP_L, SHOP_B, SHARED_EMAIL } from "./fixtures.mjs";
import { SHOP_SCENARIOS, OTHER_SCENARIOS } from "./scenarios.mjs";
import { SITES } from "./sites.mjs";

let env;
before(async () => { env = await makeEnv("demo-shopchamp-rules-allow"); });
beforeEach(async () => { await seedAll(env); });
after(async () => { await env?.cleanup(); });

const ROLE = {
  staffA: () => [as(env, U.staffA), U.staffA, SHOP_A],
  ownerA: () => [as(env, U.ownerA), U.ownerA, SHOP_A],
  ownerL: () => [as(env, U.ownerL), U.ownerL, SHOP_L],
  outsider: () => [as(env, U.outsider), U.outsider, SHOP_A],
  franchise: () => [as(env, U.franchise), U.franchise, SHOP_B],
  franchiseB: () => [as(env, U.franchiseB), U.franchiseB, SHOP_B],
  team: () => [as(env, U.team), U.team, SHOP_B],
  shared: () => [asShared(env), U.shared, SHOP_B],
};
void SHARED_EMAIL;

const shopKeys = [...new Set(SITES.map((s) => s[2]).filter((t) => t.startsWith("S:")).map((t) => t.slice(2)))];
const otherKeys = [...new Set(SITES.map((s) => s[2]).filter((t) => t.startsWith("O:")).map((t) => t.slice(2)))];

for (const key of shopKeys) {
  const fn = SHOP_SCENARIOS[key];
  for (const [shop, staff, tag] of [[SHOP_A, U.staffA, "A"], [SHOP_L, U.staffL, "L"]]) {
    test(`[ALLOW] S:${key} · ${tag}`, async () => {
      if (!fn) throw new Error(`ไม่มี scenario ${key}`);
      await assertSucceeds(fn(as(env, staff), shop));
    });
  }
}
for (const spec of otherKeys) {
  const [key, role] = spec.split("@");
  test(`[ALLOW] O:${spec}`, async () => {
    const fn = OTHER_SCENARIOS[key];
    if (!fn) throw new Error(`ไม่มี scenario ${key}`);
    if (!ROLE[role]) throw new Error(`ไม่มี role ${role}`);
    const [db, me, shop] = ROLE[role]();
    await assertSucceeds(fn(db, me, shop));
  });
}

// ทีมงาน 2 รายชื่อ (แอป · เว็บ) เข้าทุกร้าน และ care
for (const key of ["team-cross-shop-read", "team-cross-shop-write", "team-care-collections", "team-care-profile-write", "team-admin-config-ads"]) {
  for (const [u, tag] of [[U.team, "adminConfig.admin"], [U.teamWeb, "admin/admin.value"]]) {
    test(`[ALLOW] ทีมงาน ${tag} · ${key}`, async () => { await assertSucceeds(OTHER_SCENARIOS[key](as(env, u), u, SHOP_B)); });
  }
}
// เจ้าของร้านทั้ง 2 แบบ ขายได้ (ไม่ใช่แค่พนักงาน)
for (const [shop, u, tag] of [[SHOP_A, U.ownerA, "เจ้าของ A"], [SHOP_L, U.ownerL, "เจ้าของ L (shopId = uid)"]]) {
  test(`[ALLOW] ${tag} · sale-tx-month`, async () => { await assertSucceeds(SHOP_SCENARIOS["sale-tx-month"](as(env, u), shop)); });
  test(`[ALLOW] ${tag} · stock-list`, async () => { await assertSucceeds(SHOP_SCENARIOS["stock-list"](as(env, u), shop)); });
}
// รายชื่อคนที่ 80 (index 79) ยังผ่าน · พนักงานที่ status ไม่ใช่ active ก็ยังผ่าน (หลวมกว่าแอป ไม่ทำแอปเก่าพัง)
test("[ALLOW] พนักงาน index 79 ขาย 40 รายการ", async () => { await assertSucceeds(SHOP_SCENARIOS["sale-tx-120-items"](as(env, U.staffA99), SHOP_A)); });
test("[ALLOW] พนักงาน status inActive อ่านสต็อก", async () => { await assertSucceeds(SHOP_SCENARIOS["stock-list"](as(env, U.inactiveA), SHOP_A)); });
// แฟรนไชส์อ่านบิลรายใบของสาขา
test("[ALLOW] แฟรนไชส์ get บิลสาขา", async () => { await assertSucceeds(SHOP_SCENARIOS["bill-get"](as(env, U.franchise), SHOP_A)); });
void SHOP_B;
