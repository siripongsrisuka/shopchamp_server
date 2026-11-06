// เทส beam/beamMerchantCreds.js · รัน: node --test pos/gateway/beam/beamMerchantCreds.test.js
//   ① เข้ารหัส ↔ ถอด ตรงกัน · กล่องผูกร้าน+ช่อง (ย้ายข้ามร้าน = ถอดไม่ออก) · ใช้ secretBox (providerId beam-bolt)
//   ② ไม่มี/ผิดรูปกุญแจเข้ารหัส = fail-closed ทุกทาง (ตั้งไม่ได้ อ่านไม่ได้ ไม่เขียนฐาน)
//   ③ ร้านไม่มี creds = beam_merchant_not_configured · ดัชนีกลับ · ฐานไม่มี plaintext
//   ④ merchantId ซ้ำร้านอื่น = merchant_owned_by_other_shop (เขียน 0) · เปลี่ยน merchant = ย้ายดัชนี
//   ⑤ dryRun ไม่เขียน · อัปเดต webhook key แยก
//   ฐานปลอมในหน่วยความจำ · ❌ ไม่แตะ Firestore จริง · กุญแจทดสอบปลอม (ไบต์ 0..31)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const M = require("./beamMerchantCreds");
const secretBox = require("../secretBox");
const { getShopBeamCreds, getShopIdByMerchantId, setShopBeamCreds, CREDS_COLLECTION, INDEX_COLLECTION } = M;
const { encryptSecret, decryptSecret } = M._internal;

const TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const OTHER_KEY = crypto.randomBytes(32).toString("base64");
const K = { key: TEST_KEY };
const NOW = new Date("2026-11-06T03:00:00.000Z");

function makeFakeDb() {
  const store = new Map(); // "col/id" → data
  const writes = [];
  const ref = (col, id) => ({
    _k: `${col}/${id}`,
    async get() {
      const d = store.get(`${col}/${id}`);
      return { exists: d !== undefined, data: () => (d === undefined ? undefined : { ...d }) };
    },
  });
  const db = {
    collection: (col) => ({ doc: (id) => ref(col, id) }),
    async runTransaction(fn) {
      const t = {
        get: (r) => r.get(),
        set: (r, data) => { writes.push(["set", r._k]); store.set(r._k, { ...data }); },
        delete: (r) => { writes.push(["delete", r._k]); store.delete(r._k); },
      };
      return fn(t);
    },
  };
  return { db, store, writes };
}

const SHOP = "wJNgra1ik0pzRQFlZNOD";
const SHOP2 = "shopB_002";
const MERCHANT = "m_2sHxsByPwESKYM4nMwdEBdhubPS";
const MERCHANT2 = "m_otherMerchant";
const API_KEY = "pk_not_a_real_key_abc123";
const WH_KEY = "whk_not_a_real_hmac_key_456";
const ACTOR = "staff:test";

test("① เข้ารหัส ↔ ถอด ตรงกัน · กล่องไม่มีค่าลับ · iv ไม่ซ้ำ · binding = secretBox providerId beam-bolt", () => {
  const a = encryptSecret(API_KEY, { field: "apiKey", shopId: SHOP }, K);
  const b = encryptSecret(API_KEY, { field: "apiKey", shopId: SHOP }, K);
  assert.ok(a.box && b.box);
  assert.notEqual(a.box.iv, b.box.iv);
  assert.ok(!JSON.stringify(a.box).includes(API_KEY));
  assert.equal(decryptSecret(a.box, { field: "apiKey", shopId: SHOP }, K).plain, API_KEY);
  // กล่องเปิดด้วย secretBox ตรง ๆ ได้ (binding เดียวกับที่ประกาศ) — ไม่มีตัวเข้ารหัสชุดที่ 2
  const { key } = secretBox.readKey({ deps: { credKey: TEST_KEY } });
  assert.equal(secretBox.open(a.box, { providerId: "beam-bolt", field: "apiKey", shopId: SHOP }, { key }).plain, API_KEY);
});

test("① กล่องผูกร้าน+ช่อง: ถอดด้วยร้านอื่น / ช่องอื่น / แก้ ct / ผิดรูป = gateway_cred_unreadable", () => {
  const { box } = encryptSecret(API_KEY, { field: "apiKey", shopId: SHOP }, K);
  assert.equal(decryptSecret(box, { field: "apiKey", shopId: SHOP2 }, K).error.code, "gateway_cred_unreadable");
  assert.equal(decryptSecret(box, { field: "webhookHmacKey", shopId: SHOP }, K).error.code, "gateway_cred_unreadable");
  const tampered = { ...box, ct: Buffer.from("xx").toString("base64") };
  assert.equal(decryptSecret(tampered, { field: "apiKey", shopId: SHOP }, K).error.code, "gateway_cred_unreadable");
  assert.equal(decryptSecret({ alg: "aes-128-gcm", iv: "", tag: "", ct: "" }, { field: "apiKey", shopId: SHOP }, K).error.code, "gateway_cred_unreadable");
});

test("① ย้ายเอกสารทั้งก้อนไปร้านอื่นในฐาน = getShopBeamCreds ของร้านนั้นถอดไม่ออก", async () => {
  const { db, store } = makeFakeDb();
  await setShopBeamCreds(db, { shopId: SHOP, merchantId: MERCHANT, apiKey: API_KEY, actor: ACTOR }, K);
  store.set(`${CREDS_COLLECTION}/${SHOP2}`, { ...store.get(`${CREDS_COLLECTION}/${SHOP}`), shopId: SHOP2 });
  const got = await getShopBeamCreds(db, SHOP2, K);
  assert.equal(got.ok, false);
  assert.equal(got.code, "gateway_cred_unreadable");
  assert.ok(!("apiKey" in got));
});

test("② ไม่มีกุญแจเข้ารหัส → fail-closed: encrypt/decrypt/set/get ล้วนปัด · ไม่เขียนฐาน", async () => {
  const { box } = encryptSecret(API_KEY, { field: "apiKey", shopId: SHOP }, K);
  const { db, store, writes } = makeFakeDb();
  const NOKEY = { env: {} }; // env ว่าง = ไม่มี GATEWAY_CRED_ENC_KEY
  assert.equal(encryptSecret(API_KEY, { field: "apiKey", shopId: SHOP }, NOKEY).error.code, "gateway_cred_key_missing");
  assert.equal(decryptSecret(box, { field: "apiKey", shopId: SHOP }, NOKEY).error.code, "gateway_cred_key_missing");
  const set = await setShopBeamCreds(db, { shopId: SHOP, merchantId: MERCHANT, apiKey: API_KEY, actor: ACTOR }, NOKEY);
  assert.equal(set.ok, false);
  assert.equal(set.code, "gateway_cred_key_missing");
  assert.equal(writes.length, 0, "เขียนฐานทั้งที่ไม่มีกุญแจเข้ารหัส");
  store.set(`${CREDS_COLLECTION}/${SHOP}`, { shopId: SHOP, merchantId: MERCHANT, apiKey: box });
  const got = await getShopBeamCreds(db, SHOP, NOKEY);
  assert.equal(got.ok, false);
  assert.equal(got.code, "gateway_cred_key_missing");
  assert.ok(!("apiKey" in got));
});

test("② ไม่ส่ง opts เลย = อ่าน process.env (ไม่มีค่าตั้งต้น) · env/deps ส่งผ่าน secretBox.readKey", async () => {
  const saved = process.env.GATEWAY_CRED_ENC_KEY;
  delete process.env.GATEWAY_CRED_ENC_KEY;
  try {
    assert.equal(encryptSecret("x", { field: "apiKey", shopId: SHOP }).error.code, "gateway_cred_key_missing");
    process.env.GATEWAY_CRED_ENC_KEY = TEST_KEY;
    const { box } = encryptSecret("x", { field: "apiKey", shopId: SHOP });
    assert.equal(decryptSecret(box, { field: "apiKey", shopId: SHOP }, { env: { GATEWAY_CRED_ENC_KEY: TEST_KEY } }).plain, "x");
    assert.equal(decryptSecret(box, { field: "apiKey", shopId: SHOP }, { deps: { credKey: TEST_KEY } }).plain, "x");
  } finally {
    if (saved === undefined) delete process.env.GATEWAY_CRED_ENC_KEY;
    else process.env.GATEWAY_CRED_ENC_KEY = saved;
  }
});

test("② กุญแจผิดรูป → gateway_cred_key_invalid · กุญแจคนละดอก = ถอดไม่ออก", () => {
  const { box } = encryptSecret(API_KEY, { field: "apiKey", shopId: SHOP }, K);
  assert.equal(encryptSecret("x", { field: "apiKey", shopId: SHOP }, { key: crypto.randomBytes(16).toString("base64") }).error.code, "gateway_cred_key_invalid");
  assert.equal(encryptSecret("x", { field: "apiKey", shopId: SHOP }, { key: "not-base64-at-all!!" }).error.code, "gateway_cred_key_invalid");
  assert.equal(encryptSecret("x", { field: "apiKey", shopId: SHOP }, { key: crypto.randomBytes(16) }).error.code, "gateway_cred_key_invalid");
  assert.equal(decryptSecret(box, { field: "apiKey", shopId: SHOP }, { key: OTHER_KEY }).error.code, "gateway_cred_unreadable");
  // Buffer 32 ไบต์ใช้ได้
  assert.equal(decryptSecret(box, { field: "apiKey", shopId: SHOP }, { key: Buffer.from(TEST_KEY, "base64") }).plain, API_KEY);
});

test("③ set แล้ว get ได้ค่าถอดแล้ว · ดัชนีกลับชี้ร้าน · ฐาน/ผลลัพธ์ไม่มี plaintext · เวลา = now ที่ส่ง", async () => {
  const { db, store } = makeFakeDb();
  const set = await setShopBeamCreds(db, { shopId: SHOP, merchantId: MERCHANT, apiKey: API_KEY, webhookHmacKey: WH_KEY, actor: ACTOR, now: NOW }, K);
  assert.deepEqual(
    { ok: set.ok, created: set.created, hasApiKey: set.hasApiKey, hasWebhookHmacKey: set.hasWebhookHmacKey, moved: set.movedFromMerchantId, dry: set.dry },
    { ok: true, created: true, hasApiKey: true, hasWebhookHmacKey: true, moved: null, dry: false },
  );
  const dump = JSON.stringify([...store.entries()]) + JSON.stringify(set);
  assert.ok(!dump.includes(API_KEY) && !dump.includes(WH_KEY), "ค่าลับโผล่ในฐาน/ผลลัพธ์");
  const doc = store.get(`${CREDS_COLLECTION}/${SHOP}`);
  assert.ok(secretBox.isBox(doc.apiKey) && secretBox.isBox(doc.webhookHmacKey));
  assert.equal(doc.updatedBy, ACTOR);
  assert.equal(doc.updatedAt.getTime(), NOW.getTime());
  assert.equal(doc.createdAt.getTime(), NOW.getTime());
  assert.deepEqual(await getShopBeamCreds(db, SHOP, K), { ok: true, merchantId: MERCHANT, apiKey: API_KEY, webhookHmacKey: WH_KEY });
  assert.equal(await getShopIdByMerchantId(db, MERCHANT), SHOP);
  assert.equal(store.get(`${INDEX_COLLECTION}/${MERCHANT}`).shopId, SHOP);
});

test("③ ร้านไม่มี creds → beam_merchant_not_configured (ข้อความบอกทีมงาน Shopchamp) · merchantId ไม่รู้จัก/ผิดรูป → null", async () => {
  const { db } = makeFakeDb();
  const got = await getShopBeamCreds(db, SHOP, K);
  assert.equal(got.ok, false);
  assert.equal(got.code, "beam_merchant_not_configured");
  assert.match(got.message, /ติดต่อทีมงาน Shopchamp/);
  assert.ok(!("apiKey" in got));
  assert.equal(await getShopIdByMerchantId(db, MERCHANT), null);
  assert.equal(await getShopIdByMerchantId(db, "a/b"), null);
  assert.equal(await getShopIdByMerchantId(db, ""), null);
  assert.equal((await getShopBeamCreds(db, "", K)).code, "bad_input");
  assert.equal((await getShopBeamCreds(db, "x/y", K)).code, "bad_input");
});

test("③ webhookHmacKey ไม่ตั้ง → null", async () => {
  const { db } = makeFakeDb();
  await setShopBeamCreds(db, { shopId: SHOP, merchantId: MERCHANT, apiKey: API_KEY, actor: ACTOR }, K);
  assert.deepEqual(await getShopBeamCreds(db, SHOP, K), { ok: true, merchantId: MERCHANT, apiKey: API_KEY, webhookHmacKey: null });
});

test("④ merchantId ซ้ำร้านอื่น → merchant_owned_by_other_shop · เขียน 0 · ร้านเดิมอ่านได้เหมือนเดิม · ร้านเดิมหมุนกุญแจได้", async () => {
  const { db, writes } = makeFakeDb();
  await setShopBeamCreds(db, { shopId: SHOP, merchantId: MERCHANT, apiKey: API_KEY, actor: ACTOR }, K);
  const before = writes.length;
  const dup = await setShopBeamCreds(db, { shopId: SHOP2, merchantId: MERCHANT, apiKey: "other-key", actor: ACTOR }, K);
  assert.equal(dup.ok, false);
  assert.equal(dup.code, "merchant_owned_by_other_shop");
  assert.equal(writes.length, before, "เขียนฐานทั้งที่ปัด");
  assert.equal(await getShopIdByMerchantId(db, MERCHANT), SHOP);
  assert.equal((await getShopBeamCreds(db, SHOP2, K)).code, "beam_merchant_not_configured");
  const again = await setShopBeamCreds(db, { shopId: SHOP, merchantId: MERCHANT, apiKey: "rotated-key", actor: ACTOR }, K);
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal((await getShopBeamCreds(db, SHOP, K)).apiKey, "rotated-key");
});

test("④ ร้านเดิมเปลี่ยน merchantId → ดัชนีเก่าถูกลบ ดัชนีใหม่ชี้ร้าน · movedFromMerchantId บอก", async () => {
  const { db, store } = makeFakeDb();
  await setShopBeamCreds(db, { shopId: SHOP, merchantId: MERCHANT, apiKey: API_KEY, actor: ACTOR }, K);
  const mv = await setShopBeamCreds(db, { shopId: SHOP, merchantId: MERCHANT2, apiKey: API_KEY, actor: ACTOR }, K);
  assert.equal(mv.ok, true);
  assert.equal(mv.movedFromMerchantId, MERCHANT);
  assert.equal(store.has(`${INDEX_COLLECTION}/${MERCHANT}`), false);
  assert.equal(await getShopIdByMerchantId(db, MERCHANT2), SHOP);
  assert.equal((await getShopBeamCreds(db, SHOP, K)).merchantId, MERCHANT2);
});

test("⑤ dryRun → ตรวจครบแต่ไม่เขียน · ครั้งแรกไม่ส่ง apiKey = ปัด", async () => {
  const { db, writes, store } = makeFakeDb();
  const dry = await setShopBeamCreds(db, { shopId: SHOP, merchantId: MERCHANT, apiKey: API_KEY, actor: ACTOR, dryRun: true }, K);
  assert.equal(dry.ok, true);
  assert.equal(dry.dry, true);
  assert.equal(dry.created, true);
  assert.equal(writes.length, 0);
  assert.equal(store.size, 0);
  const noKey = await setShopBeamCreds(db, { shopId: SHOP, merchantId: MERCHANT, actor: ACTOR }, K);
  assert.equal(noKey.code, "bad_input");
  assert.equal(writes.length, 0);
});

test("⑤ อัปเดต webhookHmacKey แยก (ไม่ส่ง apiKey) → apiKey เดิมคงอยู่ · null = ล้าง", async () => {
  const { db } = makeFakeDb();
  await setShopBeamCreds(db, { shopId: SHOP, merchantId: MERCHANT, apiKey: API_KEY, actor: ACTOR }, K);
  const wh = await setShopBeamCreds(db, { shopId: SHOP, merchantId: MERCHANT, webhookHmacKey: WH_KEY, actor: ACTOR }, K);
  assert.equal(wh.hasWebhookHmacKey, true);
  assert.deepEqual(await getShopBeamCreds(db, SHOP, K), { ok: true, merchantId: MERCHANT, apiKey: API_KEY, webhookHmacKey: WH_KEY });
  await setShopBeamCreds(db, { shopId: SHOP, merchantId: MERCHANT, webhookHmacKey: null, actor: ACTOR }, K);
  assert.equal((await getShopBeamCreds(db, SHOP, K)).webhookHmacKey, null);
});

test("input ผิดรูป → bad_input ก่อนแตะฐาน", async () => {
  const { db, writes } = makeFakeDb();
  const cases = [
    { shopId: "", merchantId: MERCHANT, apiKey: API_KEY, actor: ACTOR },
    { shopId: "a/b", merchantId: MERCHANT, apiKey: API_KEY, actor: ACTOR },
    { shopId: SHOP, merchantId: "m:1", apiKey: API_KEY, actor: ACTOR },
    { shopId: SHOP, merchantId: "m 1", apiKey: API_KEY, actor: ACTOR },
    { shopId: SHOP, merchantId: MERCHANT, apiKey: "", actor: ACTOR },
    { shopId: SHOP, merchantId: MERCHANT, apiKey: "a:b", actor: ACTOR },
    { shopId: SHOP, merchantId: MERCHANT, apiKey: API_KEY },
    { shopId: SHOP, merchantId: MERCHANT, apiKey: API_KEY, actor: ACTOR, now: "2026-11-06" },
  ];
  for (const c of cases) {
    const r = await setShopBeamCreds(db, c, K);
    assert.equal(r.ok, false, JSON.stringify(c));
    assert.equal(r.code, "bad_input", JSON.stringify(c));
  }
  assert.equal(writes.length, 0);
});
