// เทส secretBox.js · credStore.js · settle.js (ก้อน 7) · รัน: node --test functions/pos/gateway/shared.test.js
//   ❌ ไม่แตะ Firestore จริง · กุญแจในไฟล์นี้เป็นกุญแจทดสอบ (ไบต์ 0..31) ไม่ใช่ของจริง
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

const SB = require("./secretBox");
const CS = require("./credStore");
const ST = require("./settle");

const TEST_KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64");
const KEY = SB.readKey({ deps: { credKey: TEST_KEY_B64 } }).key;
const BIND = { providerId: "ntt-h2h", field: "password", shopId: "shopA" };

// ── secretBox ────────────────────────────────────────────────────────────────
test("secretBox: ปิดแล้วเปิดได้ค่าเดิม · กล่องไม่มีค่าดิบ · iv ใหม่ทุกครั้ง", () => {
  const a = SB.seal("รหัสลับ-123", BIND, { key: KEY });
  const b = SB.seal("รหัสลับ-123", BIND, { key: KEY });
  assert.ok(SB.isBox(a.box));
  assert.notEqual(a.box.iv, b.box.iv);
  assert.ok(!JSON.stringify(a.box).includes("รหัสลับ"));
  assert.equal(SB.open(a.box, BIND, { key: KEY }).plain, "รหัสลับ-123");
});

test("secretBox: ย้ายข้ามร้าน · ข้ามช่อง · ข้ามเจ้า · แก้ ct · กุญแจอื่น = ถอดไม่ออก", () => {
  const { box } = SB.seal("x", BIND, { key: KEY });
  for (const b of [{ ...BIND, shopId: "shopB" }, { ...BIND, field: "terminalId" }, { ...BIND, providerId: "posxpay" }]) {
    assert.equal(SB.open(box, b, { key: KEY }).error.code, "gateway_cred_unreadable");
  }
  const tampered = { ...box, ct: Buffer.from("y").toString("base64") };
  assert.equal(SB.open(tampered, BIND, { key: KEY }).error.code, "gateway_cred_unreadable");
  const other = Buffer.alloc(32, 7);
  assert.equal(SB.open(box, BIND, { key: other }).error.code, "gateway_cred_unreadable");
  assert.equal(SB.open({ alg: "aes-256-gcm" }, BIND, { key: KEY }).error.code, "gateway_cred_unreadable");
});

test("secretBox.readKey: deps ก่อน env · ไม่มี = missing · ผิดรูป/ยาวผิด = invalid (fail-closed)", () => {
  assert.equal(SB.readKey({ deps: {}, env: {} }).error.code, "gateway_cred_key_missing");
  assert.equal(SB.readKey({ env: { GATEWAY_CRED_ENC_KEY: "  " } }).error.code, "gateway_cred_key_missing");
  assert.equal(SB.readKey({ env: { GATEWAY_CRED_ENC_KEY: "not base64!" } }).error.code, "gateway_cred_key_invalid");
  assert.equal(SB.readKey({ env: { GATEWAY_CRED_ENC_KEY: Buffer.alloc(16).toString("base64") } }).error.code, "gateway_cred_key_invalid");
  assert.ok(SB.readKey({ env: { GATEWAY_CRED_ENC_KEY: TEST_KEY_B64 } }).key.equals(KEY));
  assert.ok(SB.readKey({ deps: { credKey: TEST_KEY_B64 }, env: { GATEWAY_CRED_ENC_KEY: "x" } }).key.equals(KEY));
  assert.throws(() => SB.seal("x", { providerId: "p", field: "f" }, { key: KEY }), /shopId/);
});

// ── credStore ────────────────────────────────────────────────────────────────
const SPEC = {
  id: "ntt-h2h",
  connection: {
    fields: [
      { key: "terminalId", required: true },
      { key: "password", required: true, secret: true },
      { key: "note", required: false },
    ],
  },
};

test("credStore.mergeFields: ช่องลับเป็นกล่อง · ช่องธรรมดาเป็นข้อความ · values ไว้ทดสอบเป็นค่าดิบ", () => {
  const r = CS.mergeFields({ spec: SPEC, shopId: "shopA", block: null, incoming: { terminalId: " T1 ", password: "p@ss" }, key: KEY });
  assert.equal(r.ok, true);
  assert.equal(r.block.terminalId, "T1");
  assert.ok(SB.isBox(r.block.password));
  assert.deepEqual(r.values, { terminalId: "T1", password: "p@ss" });
  assert.ok(!("note" in r.block) && !("note" in r.values), "ช่องไม่บังคับที่ไม่กรอก = ไม่มี key (กติกา ③)");
});

test("credStore.mergeFields: ไม่ส่ง = คงค่าเดิม (กล่องเดิมไม่เข้ารหัสใหม่) · ส่ง '' = ล้าง", () => {
  const first = CS.mergeFields({ spec: SPEC, shopId: "shopA", block: null, incoming: { terminalId: "T1", password: "p", note: "n" }, key: KEY });
  const r = CS.mergeFields({ spec: SPEC, shopId: "shopA", block: first.block, incoming: { terminalId: "T2", note: "" }, key: KEY });
  assert.equal(r.ok, true);
  assert.equal(r.block.terminalId, "T2");
  assert.deepEqual(r.block.password, first.block.password);
  assert.equal(r.values.password, "p");
  assert.ok(!("note" in r.block));
});

test("credStore.mergeFields: ช่องไม่รู้จัก / ค่าไม่ใช่ข้อความ / ไม่มีกุญแจ = ปัด ไม่คืนค่า", () => {
  const u = CS.mergeFields({ spec: SPEC, shopId: "shopA", block: null, incoming: { pin: "1" }, key: KEY });
  assert.equal(u.code, "unknown_field");
  assert.deepEqual(u.keys, ["pin"]);
  assert.equal(CS.mergeFields({ spec: SPEC, shopId: "shopA", block: null, incoming: { terminalId: 5 }, key: KEY }).code, "bad_input");
  assert.equal(CS.mergeFields({ spec: SPEC, shopId: "shopA", block: null, incoming: { password: "p" }, key: null }).code, "gateway_cred_key_missing");
});

test("credStore: กล่องเดิมถอดไม่ได้ (กุญแจเปลี่ยน) = ปัด เว้นร้านกรอกช่องลับใหม่ทุกช่อง", () => {
  const old = CS.mergeFields({ spec: SPEC, shopId: "shopA", block: null, incoming: { terminalId: "T1", password: "p" }, key: Buffer.alloc(32, 9) });
  const r1 = CS.mergeFields({ spec: SPEC, shopId: "shopA", block: old.block, incoming: { terminalId: "T2" }, key: KEY });
  assert.equal(r1.code, "gateway_cred_unreadable");
  const r2 = CS.mergeFields({ spec: SPEC, shopId: "shopA", block: old.block, incoming: { password: "new" }, key: KEY });
  assert.equal(r2.ok, true);
  assert.equal(SB.open(r2.block.password, { providerId: "ntt-h2h", field: "password", shopId: "shopA" }, { key: KEY }).plain, "new");
});

test("credStore.openConfig: ถอดกล่อง · ช่องลับที่เป็นค่าดิบ = ไม่ใช้ (fail-closed) · กล่องร้านอื่นถอดไม่ออก", () => {
  const { block } = CS.mergeFields({ spec: SPEC, shopId: "shopA", block: null, incoming: { terminalId: "T1", password: "p" }, key: KEY });
  assert.deepEqual(CS.openConfig({ spec: SPEC, shopId: "shopA", block, key: KEY }).values, { terminalId: "T1", password: "p" });
  assert.equal(CS.openConfig({ spec: SPEC, shopId: "shopA", block: { terminalId: "T1", password: "raw" }, key: KEY }).code, "gateway_cred_unreadable");
  assert.equal(CS.openConfig({ spec: SPEC, shopId: "shopB", block, key: KEY }).code, "gateway_cred_unreadable");
  assert.deepEqual(CS.openConfig({ spec: SPEC, shopId: "shopA", block: { terminalId: "T1" }, key: null }).values, { terminalId: "T1" });
});

test("credStore.fieldStateOf: บอกแค่ตั้งแล้วหรือยัง ไม่มีค่า", () => {
  const { block } = CS.mergeFields({ spec: SPEC, shopId: "shopA", block: null, incoming: { terminalId: "T1", password: "p" }, key: KEY });
  const st = CS.fieldStateOf({ spec: SPEC, block });
  assert.deepEqual(st, [
    { key: "terminalId", secret: false, required: true, set: true },
    { key: "password", secret: true, required: true, set: true },
    { key: "note", secret: false, required: false, set: false },
  ]);
  assert.ok(!JSON.stringify(st).includes("T1"));
});

// ── settle ───────────────────────────────────────────────────────────────────
test("settle.toSatang: ปัดครั้งเดียว · ไม่รับติดลบ/NaN/ข้อความว่าง", () => {
  assert.equal(ST.toSatang(0.29), 29);
  assert.equal(ST.toSatang(19.99), 1999); // 19.99*100 = 1998.9999… ในทศนิยมลอยตัว (B-08)
  assert.equal(ST.toSatang(0.1 + 0.2), 30);
  assert.equal(ST.toSatang("120.50"), 12050);
  for (const v of [-1, Number.NaN, Infinity, "", "abc", null, undefined, {}]) assert.equal(ST.toSatang(v), null, String(v));
  assert.equal(ST.sameSatang(100, "100.00"), true);
  assert.equal(ST.sameSatang(100, 99.99), false);
  assert.equal(ST.sameSatang(null, 0), false);
});

const NOW = new Date("2026-11-10T03:00:00.000Z");
function fakeDb(docs) {
  const writes = [];
  const db = {
    collection: (c) => ({ doc: (id) => ({ c, id }) }),
    runTransaction: async (fn) => {
      const pending = [];
      const tx = {
        get: async (r) => {
          if (pending.length) throw new Error("อ่านหลังเขียน");
          const d = (docs[r.c] || {})[r.id];
          return { exists: d !== undefined, data: () => d };
        },
        update: (r, v) => pending.push({ op: "update", path: `${r.c}/${r.id}`, v }),
      };
      const out = await fn(tx);
      writes.push(...pending);
      return out;
    },
  };
  return { db, writes };
}
const reqDoc = (o = {}) => ({ shopId: "shopA", providerId: "ntt-h2h", amount: 120.5, process: "request", ...o });

test("settle.confirmPaid: จ่ายแล้ว ยอดตรงถึงสตางค์ → mark success ครั้งเดียว พร้อม verifiedBy", async () => {
  const { db, writes } = fakeDb({ pgWebhook: { r1: reqDoc() } });
  const r = await ST.confirmPaid({ db, referenceId: "r1", verified: { state: "paid", amountPaid: "120.50" }, verifiedBy: "webhook-ntt", now: NOW });
  assert.equal(r.kind, "marked");
  assert.deepEqual(writes, [{ op: "update", path: "pgWebhook/r1", v: { process: "success", paidAt: NOW, verifiedBy: "webhook-ntt", verifiedAmount: 120.5 } }]);
});

test("settle.confirmPaid: ยอดต่าง 1 สตางค์ = ไม่ mark · ประทับ verifyMismatch", async () => {
  const { db, writes } = fakeDb({ pgWebhook: { r1: reqDoc() } });
  const r = await ST.confirmPaid({ db, referenceId: "r1", verified: { state: "paid", amountPaid: 120.49 }, verifiedBy: "webhook-ntt", now: NOW });
  assert.equal(r.kind, "mismatch");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].v.process, undefined);
  assert.deepEqual(writes[0].v.verifyMismatch, { at: NOW, expected: 120.5, paid: 120.49, verifiedBy: "webhook-ntt" });
});

test("settle.confirmPaid: ยังไม่จ่าย / success แล้ว / ไม่มี doc / ร้านหรือเจ้าไม่ตรง = ไม่เขียน", async () => {
  const cases = [
    [{ state: "waiting", amountPaid: 120.5 }, reqDoc(), {}, "not_paid"],
    [{ state: "paid", amountPaid: 120.5 }, reqDoc({ process: "success" }), {}, "already"],
    [{ state: "paid", amountPaid: 120.5 }, undefined, {}, "not_found"],
    [{ state: "paid", amountPaid: 120.5 }, reqDoc(), { expectShopId: "shopB" }, "wrong_shop"],
    [{ state: "paid", amountPaid: 120.5 }, reqDoc(), { expectProviderId: "kbank-qr" }, "wrong_provider"],
    [undefined, reqDoc(), {}, "not_paid"],
  ];
  for (const [verified, doc, extra, kind] of cases) {
    const { db, writes } = fakeDb({ pgWebhook: doc ? { r1: doc } : {} });
    const r = await ST.confirmPaid({ db, referenceId: "r1", verified, verifiedBy: "x", now: NOW, ...extra });
    assert.equal(r.kind, kind);
    assert.equal(writes.length, 0, kind);
  }
});

test("settle.confirmPaid: ร้านปิดจอแล้วเงินเข้า = success + paidAfterCancel (แอปไม่สร้างบิล) · simulate ติดป้าย", async () => {
  for (const doc of [reqDoc({ process: "cancelled", cancelledAt: NOW }), reqDoc({ cancelRequestedAt: NOW })]) {
    const { db, writes } = fakeDb({ pgWebhook: { r1: doc } });
    const r = await ST.confirmPaid({ db, referenceId: "r1", verified: { state: "paid", amountPaid: 120.5 }, verifiedBy: "webhook-kbank", now: NOW });
    assert.equal(r.paidAfterCancel, true);
    assert.equal(writes[0].v.paidAfterCancel, true);
    assert.equal(writes[0].v.process, "success");
  }
  const { db, writes } = fakeDb({ pgWebhook: { r1: reqDoc() } });
  await ST.confirmPaid({ db, referenceId: "r1", verified: { state: "paid", amountPaid: 120.5 }, verifiedBy: "simulate", now: NOW, simulated: true });
  assert.equal(writes[0].v.simulated, true);
  assert.equal(writes[0].v.paidAfterCancel, undefined);
});
