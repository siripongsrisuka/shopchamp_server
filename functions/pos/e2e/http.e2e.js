// pos/e2e/http.e2e.js — ยิง HTTP จริงเข้า express app ของ pos/pos_heavy บน Firestore emulator (ก้อน 4 · DEV-0001)
// รัน: cd functions && npm run test:e2e   (ห้ามรันตรง · _env.js ปัดถ้าไม่ได้ต่อ emulator)
//
// ของจริงทั้งสาย: app.js (gate · scrub · bodyLimit · express.json) → requireShopAccess ตัวจริง (อ่าน shop/admin จาก emulator)
//   → handler ตัวจริง · ที่ปลอมมีแค่ verifyIdToken (token "tok-<uid>" · ไม่เรียก Firebase Auth) และนาฬิกา (ตรึงตาม fixture)
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const E = require("./_env");
const { makeApp } = require("../app");
const { makeCheckIfAuthenticated } = require("../_shared/auth");
const { ROUTES } = require("../routes");

const { seed, get, clock, saleBody, reqId, NOW_ISO } = E;

const authn = makeCheckIfAuthenticated({ verifyIdToken: async (t) => { if (!/^tok-/.test(t)) throw Object.assign(new Error("bad"), { code: "auth/argument-error" }); return { uid: t.slice(4) }; }, log: () => {} });
const servers = [];
async function serve(fnName) {
  const app = makeApp({ fnName, deps: clock(NOW_ISO), checkIfAuthenticated: authn });
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  servers.push(srv);
  return `http://127.0.0.1:${srv.address().port}`;
}
async function post(base, p, body, uid) {
  const headers = { "content-type": "application/json" };
  if (uid) headers.authorization = `Bearer tok-${uid}`;
  const r = await fetch(base + p, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* ไม่ใช่ JSON = ผิดซอง */ }
  return { status: r.status, body: json, text };
}
const shape = (r) => `${r.status} ${r.text.slice(0, 300)}`;

let POS;
let HEAVY;
let f;
before(async () => {
  await E.ready();
  f = E.shopFixture();
  f.data.profile = { [f.id.owner]: { currentLogin: { shopId: f.id.shopA }, name: "เจ้าของ" } };
  await seed(f.data);
  POS = await serve("pos");
  HEAVY = await serve("pos_heavy");
});
after(async () => { for (const s of servers) await new Promise((r) => s.close(r)); });

test("ทุก route: ไม่มี token = 401 no_auth ในซองเดียว · token ปลอมรูปผิด = 401", async () => {
  for (const r of ROUTES) {
    const base = r.fn === "pos_heavy" ? HEAVY : POS;
    const no = await post(base, r.path, { shopId: f.id.shopA });
    assert.deepEqual([no.status, no.body && no.body.ok, no.body && no.body.error], [401, false, "no_auth"], `${r.path}: ${shape(no)}`);
    const bad = await fetch(base + r.path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer junk" }, body: "{}" });
    assert.equal(bad.status, 401, r.path);
  }
});

test("ทุก route ที่ผูกร้าน: คนนอกร้าน = 403 not_shop_member · ร้านไม่มี = 404 (requireShopAccess ตัวจริงอ่าน emulator)", async () => {
  for (const r of ROUTES.filter((x) => x.auth === "shop")) {
    const out = await post(POS, r.path, { shopId: f.id.shopA }, `u-stranger${f.id.n}`);
    assert.deepEqual([out.status, out.body.error], [403, "not_shop_member"], `${r.path}: ${shape(out)}`);
    const other = await post(POS, r.path, { shopId: f.id.shopB }, f.id.owner);
    assert.deepEqual([other.status, other.body.error], [403, "not_shop_member"], `${r.path} ร้านอื่น: ${shape(other)}`);
    const none = await post(POS, r.path, { shopId: `nope${f.id.n}` }, f.id.owner);
    assert.deepEqual([none.status, none.body.error], [404, "shop_not_found"], `${r.path}: ${shape(none)}`);
  }
});

test("ทางสำเร็จทีละ route ผ่าน HTTP: ping · profile · ขาย · ซ้ำ · ดึงบิล · แก้ · ยกเลิก · ลบค้างส่ง · เงินระหว่างกะ · รับชำระ", async () => {
  const owner = f.id.owner;
  const shopId = f.id.shopA;

  const ping = await post(POS, "/system/ping", { shopId }, owner);
  assert.deepEqual([ping.status, ping.body], [200, { ok: true, service: "pos", shopId }], shape(ping));
  const pingHeavy = await post(HEAVY, "/system/ping", { shopId }, owner);
  assert.equal(pingHeavy.status, 200, shape(pingHeavy));

  const prof = await post(POS, "/profile/loading", { platform: "android" }, owner);
  assert.equal(prof.status, 200, shape(prof));
  assert.equal(prof.body.ok, true);

  const body = saleBody(f);
  const sale = await post(POS, "/sale/create", body, owner);
  assert.equal(sale.status, 200, shape(sale));
  assert.equal(sale.body.receiptNumber, "202611000042");
  const dup = await post(POS, "/sale/create", body, owner);
  assert.deepEqual([dup.status, dup.body.duplicate, dup.body.billId], [200, true, sale.body.billId], shape(dup));
  assert.equal((await get("billId", shopId)).receipts, 42, "ส่งซ้ำไม่เผาเลข");

  const g = await post(POS, "/sale/get", { shopId, billId: sale.body.billId }, owner);
  assert.equal(g.status, 200, shape(g));

  const amend = await post(POS, "/sale/amend", {
    shopId, billId: sale.body.billId, requestId: reqId(), reason: "ลูกค้าคืน 1 ขวด", staffId: owner, staffName: "เจ้าของ",
    product: [{ fromIndex: 0, id: f.id.pWater, qty: 1, name: "น้ำดื่ม", net: 10, totalPrice: 10, totalCost: 6 }],
    payment: [{ id: 1, amount: 10, name: "เงินสด" }], moneyMustPaid: 10,
  }, owner);
  assert.equal(amend.status, 200, shape(amend));
  assert.equal(amend.body.status, "done");

  const second = await post(POS, "/sale/create", saleBody(f), owner);
  assert.equal(second.status, 200, shape(second));
  // amendVoid ใน body ต้องถูกลบก่อนถึง handler (ไม่งั้น strict schema ปัด 400 หรือข้ามด่าน)
  const v = await post(POS, "/sale/void", { shopId, billId: second.body.billId, requestId: reqId(), reason: "คีย์ผิด", staffId: owner, staffName: "เจ้าของ", shiftId: f.id.sh1, amendVoid: true }, owner);
  assert.equal(v.status, 200, shape(v));
  assert.equal((await get("bill", second.body.billId)).void, true);

  const uuid = E.uuid(shopId);
  const disc = await post(POS, "/sale/discard-pending", { shopId, receiptUUID: uuid, offlineRef: "T261110-AB12-01", body: { shopId, receiptUUID: uuid, moneyMustPaid: 20, product: [{ id: f.id.pWater, qty: 2 }] }, reason: "ขายซ้ำ", deviceAt: "2026-11-10T09:00:00+07:00" }, owner);
  assert.deepEqual([disc.status, disc.body.duplicate], [200, false], shape(disc));

  const during = await post(POS, "/shift/manage", { shopId, shiftId: f.id.sh1, staffId: owner, staffName: "เจ้าของ", requestId: reqId(), op: "during", type: 1, amount: "50", comment: "เติมเหรียญ" }, owner);
  assert.equal(during.status, 200, shape(during));

  const credit = await post(POS, "/sale/create", saleBody(f, { member: { id: f.id.m1, name: "ลูกค้าเอ" }, payment: [{ id: 3, amount: 20, name: "เงินเซ็น" }], change: 0, currentCredit: 20 }), owner);
  assert.equal(credit.status, 200, shape(credit));
  const pay = await post(POS, "/member/pay-credit", { shopId, memberId: f.id.m1, amount: 15, paymentId: 1, shiftId: f.id.sh1, staffId: f.id.staff, staffName: "พนักงานบี", payUUID: reqId() }, f.id.staff);
  assert.equal(pay.status, 200, shape(pay));
  assert.equal(pay.body.paid, 15);
});

test("แยก function: เส้นเงินที่ pos_heavy = 404 wrong_function ชี้ pos · เส้นไม่รู้จัก = 404 not_found", async () => {
  const w = await post(HEAVY, "/sale/create", saleBody(f), f.id.owner);
  assert.deepEqual([w.status, w.body.error, w.body.serve], [404, "wrong_function", "pos"], shape(w));
  const nf = await post(POS, "/report/x", {}, f.id.owner);
  assert.deepEqual([nf.status, nf.body.error], [404, "not_found"]);
});
