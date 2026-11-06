// เทส auth.js · รัน: node --test functions/pos/_shared/
//   harness รัน middleware ไม่ได้ (chunk4-contracts.md "⚠️ ด่าน requireShopAccess") ⇒ ตัวตัดสินจริงพิสูจน์ที่นี่ทั้ง 2 ทิศ
//   ฐานปลอมในไฟล์นี้อ่านอย่างเดียวและนับครั้งที่อ่าน · ❌ ไม่แตะ Firestore จริง (โหลดไฟล์นี้ไม่ require firebase-admin)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const A = require("./auth");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime() }; };
const FUTURE = ts("2027-01-01T00:00:00Z"), PAST = ts("2026-01-01T00:00:00Z");

function shopA(vip) {
  return {
    shopId: "shopA",
    humanResource: [
      { id: "u-owner", name: "เจ้าของ", position: ["001"], status: "active", password: "1234" },
      { id: "u-staff", name: "พนักงานบี", position: ["002"], status: "active", rights: ["116"] },
      { id: "u-off", name: "พักงาน", position: ["002"], status: "inActive", rights: ["116"] },
      { id: "u-legacy", name: "ไม่มี status", position: ["002"] },
    ],
    vip: vip === undefined ? [{ type: "staff", expire: FUTURE }] : vip,
  };
}
function fakeDb(data) {
  const reads = [];
  return {
    reads,
    collection: (c) => ({
      doc: (id) => ({
        get: async () => {
          reads.push(`${c}/${id}`);
          if (data.__throw) throw new Error("db down");
          const d = (data[c] || {})[id];
          return { exists: d !== undefined, id, data: () => d };
        },
      }),
    }),
  };
}
function res() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
async function runShop(db, req) {
  const mw = A.makeRequireShopAccess({ db, now: () => NOW, log: () => {} });
  const r = res();
  let nexted = false;
  await mw(req, r, () => { nexted = true; });
  return { r, nexted, req };
}
const ADMIN = { admin: { adminConfig: { admin: ["u-company"] } } };

// ── requireShopAccess: ต้องผ่าน ──
test("ผ่าน: เจ้าของ (position 001) → role owner rights [] · ไม่อ่าน adminConfig", async () => {
  const db = fakeDb({ shop: { shopA: shopA() }, ...ADMIN });
  const { nexted, req, r } = await runShop(db, { body: { shopId: "shopA" }, auth: { uid: "u-owner" } });
  assert.equal(nexted, true);
  assert.equal(r.code, 0);
  assert.deepEqual(req.shopAccess, { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] });
  assert.deepEqual(db.reads, ["shop/shopA"]);
});

test("ผ่าน: เจ้าของ index 0 เข้าได้แม้แพ็กเกจ staff หมด (กติกาแอปเก่า)", async () => {
  const { nexted, req } = await runShop(fakeDb({ shop: { shopA: shopA([{ type: "staff", expire: PAST }]) } }), { body: { shopId: "shopA" }, auth: { uid: "u-owner" } });
  assert.equal(nexted, true);
  assert.equal(req.shopAccess.role, "owner");
});

test("ผ่าน: พนักงานที่มีแพ็กเกจ staff → role staff rights ของตัวเอง", async () => {
  const { nexted, req } = await runShop(fakeDb({ shop: { shopA: shopA() } }), { body: { shopId: "shopA" }, auth: { uid: "u-staff" } });
  assert.equal(nexted, true);
  assert.deepEqual(req.shopAccess, { shopId: "shopA", uid: "u-staff", role: "staff", rights: ["116"] });
});

test("ผ่าน: ทีมงาน Shopchamp ไม่อยู่ในร้าน → owner + byAdmin (Pack 3-2)", async () => {
  const db = fakeDb({ shop: { shopA: shopA() }, ...ADMIN });
  const { nexted, req } = await runShop(db, { body: { shopId: "shopA" }, auth: { uid: "u-company" } });
  assert.equal(nexted, true);
  assert.deepEqual(req.shopAccess, { shopId: "shopA", uid: "u-company", role: "owner", rights: [], byAdmin: true });
  assert.deepEqual(db.reads, ["shop/shopA", "admin/adminConfig"]);
});

test("ผ่าน: ทีมงานเข้าได้แม้ร้านไม่มี humanResource เลย (ร้านรุ่นแรก)", async () => {
  const { nexted, req } = await runShop(fakeDb({ shop: { shopA: { shopId: "shopA" } }, ...ADMIN }), { body: { shopId: "shopA" }, auth: { uid: "u-company" } });
  assert.equal(nexted, true);
  assert.equal(req.shopAccess.byAdmin, true);
});

// ── requireShopAccess: ต้องปัด ──
test("ปัด: ไม่อยู่ใน humanResource → 403 not_shop_member reason not_a_member", async () => {
  const { nexted, r, req } = await runShop(fakeDb({ shop: { shopA: shopA() }, ...ADMIN }), { body: { shopId: "shopA" }, auth: { uid: "u-stranger" } });
  assert.equal(nexted, false);
  assert.equal(r.code, 403);
  assert.deepEqual(r.body, { reason: "not_a_member", ok: false, error: "not_shop_member", message: r.body.message });
  assert.equal(req.shopAccess, undefined);
});

test("ปัด: พนักงานแพ็กเกจ staff หมด / ไม่มีแพ็กเกจ → 403 reason inactive", async () => {
  for (const vip of [[{ type: "staff", expire: PAST }], [], [{ type: "premium", expire: FUTURE }]]) {
    const { nexted, r } = await runShop(fakeDb({ shop: { shopA: shopA(vip) } }), { body: { shopId: "shopA" }, auth: { uid: "u-staff" } });
    assert.equal(nexted, false);
    assert.equal(r.code, 403);
    assert.equal(r.body.reason, "inactive");
  }
});

test("ปัด: status ไม่ใช่ 'active' (inActive · ไม่มี status แบบร้านเก่า S4) → 403 inactive", async () => {
  for (const uid of ["u-off", "u-legacy"]) {
    const { r } = await runShop(fakeDb({ shop: { shopA: shopA() } }), { body: { shopId: "shopA" }, auth: { uid } });
    assert.equal(r.code, 403, uid);
    assert.equal(r.body.reason, "inactive", uid);
  }
});

test("ปัด (fail-closed): adminConfig ไม่มี · ช่อง admin ไม่ใช่ array · เป็น string → ทีมงานไม่ทะลุ", async () => {
  for (const admin of [{}, { adminConfig: {} }, { adminConfig: { admin: "u-company" } }, { adminConfig: { admin: { 0: "u-company" } } }]) {
    const { nexted, r } = await runShop(fakeDb({ shop: { shopA: shopA() }, admin }), { body: { shopId: "shopA" }, auth: { uid: "u-company" } });
    assert.equal(nexted, false, JSON.stringify(admin));
    assert.equal(r.code, 403);
    assert.equal(r.body.error, "not_shop_member");
  }
});

test("ปัด: ร้านไม่มี → 404 shop_not_found · shopId ไม่มี/รูปผิด → 400 · ไม่มี req.auth → 401 · ฐานล้ม → 500", async () => {
  assert.equal((await runShop(fakeDb({ shop: {} }), { body: { shopId: "shopZ" }, auth: { uid: "u-owner" } })).r.code, 404);
  for (const body of [undefined, {}, { shopId: "" }, { shopId: "a/b" }, { shopId: 5 }, { shopId: "x".repeat(129) }]) {
    const { r, nexted } = await runShop(fakeDb({ shop: { shopA: shopA() } }), { body, auth: { uid: "u-owner" } });
    assert.equal(r.code, 400, JSON.stringify(body));
    assert.equal(r.body.error, "missing_shop_id");
    assert.equal(nexted, false);
  }
  for (const auth of [undefined, {}, { uid: "" }]) {
    assert.equal((await runShop(fakeDb({ shop: { shopA: shopA() } }), { body: { shopId: "shopA" }, auth })).r.code, 401);
  }
  const down = await runShop(fakeDb({ __throw: true }), { body: { shopId: "shopA" }, auth: { uid: "u-owner" } });
  assert.equal(down.r.code, 500);
  assert.equal(down.r.body.error, "internal_error");
});

test("ไม่ส่งข้อมูลลับออก: คำตอบปัดไม่มี humanResource / password", async () => {
  const { r } = await runShop(fakeDb({ shop: { shopA: shopA() } }), { body: { shopId: "shopA" }, auth: { uid: "u-stranger" } });
  assert.equal(JSON.stringify(r.body).includes("1234"), false);
});

// ── checkIfAuthenticated ──
async function runAuth(headers, verify) {
  const mw = A.makeCheckIfAuthenticated({ verifyIdToken: verify, log: () => {} });
  const req = { headers };
  const r = res();
  let nexted = false;
  await mw(req, r, () => { nexted = true; });
  return { req, r, nexted };
}

test("checkIfAuthenticated ผ่าน: Bearer token → verify(token, true) → req.auth {uid, email ตัวเล็ก}", async () => {
  const calls = [];
  const { req, nexted } = await runAuth({ authorization: "Bearer tok123" }, async (t, c) => { calls.push([t, c]); return { uid: "u1", email: " A@B.com " }; });
  assert.equal(nexted, true);
  assert.deepEqual(calls, [["tok123", true]]);
  assert.deepEqual(req.auth, { uid: "u1", email: "a@b.com" });
});

test("checkIfAuthenticated ปัด 401 no_auth: ไม่มี header · ไม่ใช่ Bearer · token ว่าง · verify ล้ม · ไม่มี uid", async () => {
  const okVerify = async () => ({ uid: "u1" });
  for (const h of [{}, { authorization: "Basic abc" }, { authorization: "Bearer " }, { authorization: "tok" }]) {
    const { r, nexted } = await runAuth(h, okVerify);
    assert.equal(r.code, 401, JSON.stringify(h));
    assert.equal(r.body.error, "no_auth");
    assert.equal(nexted, false);
  }
  const revoked = await runAuth({ authorization: "Bearer t" }, async () => { const e = new Error("revoked"); e.code = "auth/id-token-revoked"; throw e; });
  assert.equal(revoked.r.code, 401);
  const noUid = await runAuth({ authorization: "Bearer t" }, async () => ({}));
  assert.equal(noUid.r.code, 401);
});

test("checkIfAuthenticated: log ไม่มี token", async () => {
  const logged = [];
  const mw = A.makeCheckIfAuthenticated({ verifyIdToken: async () => { throw new Error("bad tokSECRET"); }, log: (...a) => logged.push(a.join(" ")) });
  await mw({ headers: { authorization: "Bearer tokSECRET" } }, res(), () => {});
  assert.equal(logged.join("").includes("tokSECRET"), false);
});

test("โหลดไฟล์นี้ไม่ require firebase-admin (harness ปัดถ้าโหลด SDK จริง)", () => {
  assert.equal(Object.keys(require.cache).some((k) => /[\\/]node_modules[\\/]firebase-admin[\\/]/.test(k)), false);
});

// ── ด่านในตัว handler ──
test("callerAccess: ไม่มี shopAccess → 401 no_shop_access · shopId ไม่ตรง → 403 wrong_shop · ตรง → ok", () => {
  const owner = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
  assert.deepEqual(A.callerAccess({}, "shopA"), { ok: false, status: 401, error: "no_shop_access" });
  assert.equal(A.callerAccess({ shopAccess: { shopId: "", uid: "u", role: "owner" } }, "").error, "no_shop_access");
  assert.equal(A.callerAccess({ shopAccess: { shopId: "shopA", uid: "u", role: "root" } }, "shopA").error, "no_shop_access");
  assert.deepEqual(A.callerAccess({ shopAccess: owner }, "shopB"), { ok: false, status: 403, error: "wrong_shop" });
  assert.equal(A.callerAccess({ shopAccess: owner }, undefined).error, "wrong_shop");
  assert.equal(A.callerAccess({ shopAccess: { ...owner, byAdmin: true } }, "shopB").error, "wrong_shop"); // ทีมงานก็ถูกจำกัด
  assert.deepEqual(A.callerAccess({ shopAccess: owner }, "shopA"), { ok: true, access: owner });
});

test("hasRight / isOwner: เจ้าของ+ทีมงานผ่านทุกสิทธิ์ · พนักงานต้องมีรหัส ('116' ไม่ให้ '143')", () => {
  const staff = { role: "staff", rights: ["116"] };
  assert.equal(A.hasRight({ role: "owner", rights: [] }, "143"), true);
  assert.equal(A.hasRight({ role: "owner", rights: [], byAdmin: true }, "143"), true);
  assert.equal(A.hasRight(staff, "116"), true);
  assert.equal(A.hasRight(staff, "143"), false);
  assert.equal(A.hasRight({ role: "staff" }, "116"), false);
  assert.equal(A.hasRight(null, "116"), false);
  assert.equal(A.isOwner(staff), false);
  assert.equal(A.isOwner({ role: "owner", byAdmin: true }), true);
});

test("adminTrail / adminFlag: ทีมงานได้ {byAdmin, adminUid} · คนทั่วไป {}", () => {
  assert.deepEqual(A.adminTrail({ uid: "u-company", byAdmin: true }), { byAdmin: true, adminUid: "u-company" });
  assert.deepEqual(A.adminFlag({ uid: "u-company", byAdmin: true }), { byAdmin: true });
  assert.deepEqual(A.adminTrail({ uid: "u-owner", role: "owner" }), {});
  assert.deepEqual(A.adminFlag({ uid: "u-owner", byAdmin: "true" }), {});
});

test("checkOwnedDoc / belongsToShop: ไม่มี = 404 · ร้านอื่น = 409 · ตรง doc id หรือ field shopId = ผ่าน", () => {
  const ref = A.shopRefOf("docX", { shopId: "uidOwner" });
  assert.deepEqual(ref, { id: "docX", shopId: "uidOwner" });
  assert.deepEqual(A.checkOwnedDoc("bill", undefined, ref), { ok: false, status: 404, error: "bill_not_found" });
  assert.deepEqual(A.checkOwnedDoc("bill", { shopId: "shopB" }, ref), { ok: false, status: 409, error: "bill_other_shop" });
  assert.equal(A.checkOwnedDoc("member", { shopId: "uidOwner" }, ref).ok, true);
  assert.equal(A.checkOwnedDoc("shift", { shopId: "docX" }, ref).ok, true);
  assert.equal(A.checkOwnedDoc("shift", {}, ref).error, "shift_other_shop"); // ไม่มี shopId = ไม่ใช่ของร้านนี้
  assert.equal(A.belongsToShop("", ref), false);
  assert.equal(A.belongsToShop(null, A.shopRefOf("docX", {})), false);
});

test("staffInShop: อยู่ใน humanResource · ทีมงานใช้ uid ตัวเองได้ · คนอื่นไม่ได้", () => {
  const shop = shopA();
  assert.equal(A.staffInShop(shop, "u-staff", { uid: "u-owner" }), true);
  assert.equal(A.staffInShop(shop, "u-company", { uid: "u-company", byAdmin: true }), true);
  assert.equal(A.staffInShop(shop, "u-company", { uid: "u-owner" }), false);
  assert.equal(A.staffInShop(shop, "u-other", { uid: "u-company", byAdmin: true }), false);
  assert.equal(A.staffInShop(shop, "", {}), false);
});

test("memberStatusOf (ใช้ร่วม profile.loading): active · inactive · not_a_member", () => {
  assert.equal(A.memberStatusOf(shopA(), "u-owner", NOW).status, "active");
  assert.equal(A.memberStatusOf(shopA([]), "u-staff", NOW).status, "inactive");
  assert.equal(A.memberStatusOf(shopA(), "nobody", NOW).status, "not_a_member");
  assert.equal(A.memberStatusOf({}, "u-owner", NOW).status, "not_a_member");
  assert.equal(A.INITIAL_RIGHTS.includes("143"), true);
});
