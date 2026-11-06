// pos/gateway/beam/beamMerchantCreds.js — กุญแจ Beam รายร้าน (merchantId + Partner API Key) · ก้อน 7 · DEV-0001
//
// ยกจากพี่น้อง: Shopchamp = partner ใน Bridge · ร้าน = merchant ใต้ partner · เงินเข้าบัญชีร้าน
//   ⇒ ทุกคำขอไป Beam ใช้ Basic base64(<merchantId ของร้าน>:<Partner API Key ที่ออกต่อ merchant นั้น>)
//   กุญแจเป็นรายร้าน · ทีมงาน Shopchamp กรอกให้ (ร้านไม่เห็น) · ตอนนี้มีแค่ฟังก์ชัน `setShopBeamCreds` ยังไม่มี route
//
// ที่เก็บ (collection ระดับบน · ❌ ไม่อยู่ใต้ shop/{shopId}/meta/* ที่แอปร้านอ่านเขียน):
//   · beamMerchantCreds/{shopId}     = { shopId, merchantId, apiKey:<กล่อง>, webhookHmacKey:<กล่อง>|null, createdAt, updatedAt, updatedBy }
//   · beamMerchantIndex/{merchantId} = { shopId, merchantId, updatedAt }  ← ดัชนีกลับ (webhook ของ Beam บอกแค่ merchantId)
//   merchantId 1 ตัว = 1 ร้าน — ตั้งซ้ำให้ร้านอื่น = merchant_owned_by_other_shop (ตรวจใน txn เดียวกับที่เขียน)
//
// เข้ารหัสด้วย ../secretBox.js (AES-256-GCM · env GATEWAY_CRED_ENC_KEY · ไม่มี/ผิดรูป = fail-closed)
//   binding = { providerId:'beam-bolt', field:'apiKey'|'webhookHmacKey', shopId } ⇒ ย้ายกล่องข้ามร้าน/ช่อง = ถอดไม่ออก
//   กุญแจเข้ารหัส: opts ตัวท้ายของทุกฟังก์ชัน = { key } (Buffer หรือ base64) | { deps, env } (ส่งต่อ secretBox.readKey) · ไม่ส่ง = process.env
//   ❌ ไม่ log ค่าลับ · setShopBeamCreds ไม่คืนค่าลับ · getShopBeamCreds คืนค่าถอดแล้วให้ผู้เรียกฝั่ง server เท่านั้น
//
// สัญญา (ผู้ให้บริการ beam-bolt และ webhook ใช้ · ห้ามเปลี่ยนชื่อ/รูป):
//   getShopBeamCreds(db, shopId, opts?)          → {ok:true, merchantId, apiKey, webhookHmacKey|null} | {ok:false, code, message}
//   getShopIdByMerchantId(db, merchantId)        → shopId | null
//   setShopBeamCreds(db, {shopId, merchantId, apiKey?, webhookHmacKey?, actor, dryRun?, now?}, opts?)
//                                                → {ok:true, ...ไม่มีค่าลับ} | {ok:false, code, message}
"use strict";

const secretBox = require("../secretBox");

const PROVIDER_ID = "beam-bolt";
const CREDS_COLLECTION = "beamMerchantCreds";
const INDEX_COLLECTION = "beamMerchantIndex";
const ENC_KEY_ENV = secretBox.ENC_KEY_ENV;

const fail = (code, message) => ({ ok: false, code, message });
const dbOr = (db) => db || require("../../../firebase").db; // ไม่ส่ง db = ฐานจริง (โหลดช้า)

/** doc id ที่ปลอดภัย: ไม่ว่าง · ไม่มี '/' · ไม่ใช่ '.'/'..' · ไม่มี ':'/ช่องว่าง (merchantId = username ของ Basic) · ≤ 1500 ไบต์ */
function isSafeId(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s || s !== v || s === "." || s === ".." || s.includes("/")) return false;
  if (/[\s:]/.test(s)) return false;
  return Buffer.byteLength(s, "utf8") <= 1500;
}

/** กุญแจเข้ารหัส → {key:Buffer} | {error:{ok:false,code,message}} · opts.key ชนะ · ไม่มีค่าตั้งต้น */
function readEncKey(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  let r;
  if (Buffer.isBuffer(o.key)) r = o.key.length === 32 ? { key: o.key } : { error: { code: "gateway_cred_key_invalid", message: "กุญแจเข้ารหัสต้องยาว 32 ไบต์" } };
  else if (typeof o.key === "string") r = secretBox.readKey({ deps: { credKey: o.key } });
  else r = secretBox.readKey({ deps: o.deps, env: o.env });
  if (r.error) return { error: fail(r.error.code, r.error.message) };
  return { key: r.key };
}

const bindingOf = (field, shopId) => ({ providerId: PROVIDER_ID, field, shopId });

/** เข้ารหัส 1 ค่า → {box} | {error} */
function encryptSecret(plain, { field, shopId }, opts) {
  const k = readEncKey(opts);
  if (k.error) return k;
  const r = secretBox.seal(String(plain), bindingOf(field, shopId), { key: k.key });
  return r.error ? { error: fail(r.error.code, r.error.message) } : { box: r.box };
}

/** ถอดกล่อง → {plain} | {error} · ผิดรูป/แท็กไม่ตรง/ย้ายข้ามร้าน = gateway_cred_unreadable (ไม่ throw) */
function decryptSecret(box, { field, shopId }, opts) {
  const k = readEncKey(opts);
  if (k.error) return k;
  const r = secretBox.open(box, bindingOf(field, shopId), { key: k.key });
  return r.error ? { error: fail(r.error.code, r.error.message) } : { plain: r.plain };
}

const credsRef = (db, shopId) => db.collection(CREDS_COLLECTION).doc(shopId);
const indexRef = (db, merchantId) => db.collection(INDEX_COLLECTION).doc(merchantId);

// ── อ่าน ──

/**
 * กุญแจ Beam ของร้าน (ถอดแล้ว) — server-side เท่านั้น ❌ ห้าม serialize ออก HTTP
 * code ที่ปัด: bad_input · beam_merchant_not_configured · gateway_cred_key_missing · gateway_cred_key_invalid · gateway_cred_unreadable
 */
async function getShopBeamCreds(db, shopId, opts) {
  if (!isSafeId(shopId)) return fail("bad_input", "shopId ผิดรูป");
  const snap = await credsRef(dbOr(db), shopId).get();
  const d = snap && snap.exists ? snap.data() || {} : null;
  if (!d || !isSafeId(d.merchantId) || !d.apiKey) {
    return fail("beam_merchant_not_configured", "ร้านนี้ยังไม่ได้เปิดบัญชีรับเงิน Beam — ติดต่อทีมงาน Shopchamp");
  }
  const api = decryptSecret(d.apiKey, { field: "apiKey", shopId }, opts);
  if (api.error) return api.error;
  let webhookHmacKey = null;
  if (d.webhookHmacKey) {
    const wh = decryptSecret(d.webhookHmacKey, { field: "webhookHmacKey", shopId }, opts);
    if (wh.error) return wh.error;
    webhookHmacKey = wh.plain;
  }
  return { ok: true, merchantId: d.merchantId, apiKey: api.plain, webhookHmacKey };
}

/** ดัชนีกลับ merchantId → shopId (ใช้ตอน webhook ของ Beam มาถึง) · ไม่มี/ผิดรูป = null ไม่ throw */
async function getShopIdByMerchantId(db, merchantId) {
  if (!isSafeId(merchantId)) return null;
  const snap = await indexRef(dbOr(db), merchantId).get();
  const d = snap && snap.exists ? snap.data() || {} : null;
  return d && isSafeId(d.shopId) ? d.shopId : null;
}

// ── เขียน (ทีมงาน Shopchamp · ภายหลัง = จอ office) ──

/** ตรวจ input → {v} | {error} · apiKey ไม่ส่ง (undefined) = คงของเดิม */
function readSetInput(input) {
  const i = input && typeof input === "object" ? input : {};
  if (!isSafeId(i.shopId)) return { error: fail("bad_input", "shopId ผิดรูป") };
  if (!isSafeId(i.merchantId)) return { error: fail("bad_input", "merchantId ผิดรูป (ห้ามว่าง/มีช่องว่าง/มี ':' หรือ '/')") };
  const secretOk = (v) => typeof v === "string" && v.trim() && !/[\s:]/.test(v);
  if (i.apiKey !== undefined && !secretOk(i.apiKey)) return { error: fail("bad_input", "apiKey ผิดรูป (ต้องเป็นข้อความ ไม่ว่าง ไม่มีช่องว่าง/':')") };
  if (i.webhookHmacKey !== undefined && i.webhookHmacKey !== null && !secretOk(i.webhookHmacKey)) {
    return { error: fail("bad_input", "webhookHmacKey ผิดรูป") };
  }
  const actor = typeof i.actor === "string" && i.actor.trim() ? i.actor.trim() : "";
  if (!actor) return { error: fail("bad_input", "ต้องระบุ actor (ใครเป็นคนตั้ง)") };
  if (i.now !== undefined && !(i.now instanceof Date && Number.isFinite(i.now.getTime()))) {
    return { error: fail("bad_input", "now ต้องเป็น Date ที่ใช้ได้") };
  }
  return { v: { shopId: i.shopId, merchantId: i.merchantId, apiKey: i.apiKey, webhookHmacKey: i.webhookHmacKey, actor } };
}

/** เข้ารหัสค่าลับที่ส่งมา (ตัวที่ไม่ส่ง = ไม่แตะ) — นอก txn เพราะไม่แตะฐาน */
function encryptSetSecrets(v, opts) {
  const boxes = {};
  if (v.apiKey !== undefined) {
    const e = encryptSecret(v.apiKey, { field: "apiKey", shopId: v.shopId }, opts);
    if (e.error) return e;
    boxes.apiKey = e.box;
  }
  if (v.webhookHmacKey !== undefined) {
    if (v.webhookHmacKey === null) boxes.webhookHmacKey = null;
    else {
      const e = encryptSecret(v.webhookHmacKey, { field: "webhookHmacKey", shopId: v.shopId }, opts);
      if (e.error) return e;
      boxes.webhookHmacKey = e.box;
    }
  }
  return { boxes };
}

/**
 * ตั้ง/อัปเดตกุญแจ Beam ของร้าน — txn เดียว: ดัชนี merchantId ต้องว่างหรือเป็นของร้านนี้ · เปลี่ยน merchantId = ย้ายดัชนี
 *   apiKey ไม่ส่ง = คงเดิม (ต้องมีของเดิม) · webhookHmacKey ไม่ส่ง = คงเดิม · null = ล้าง · dryRun:true = ตรวจครบแต่ไม่เขียน
 * @returns {Promise<{ok:true, shopId, merchantId, created, hasApiKey, hasWebhookHmacKey, movedFromMerchantId, dry} | {ok:false, code, message}>}
 */
async function setShopBeamCreds(db, input, opts) {
  const r = readSetInput(input);
  if (r.error) return r.error;
  const v = r.v;
  const enc = encryptSetSecrets(v, opts);
  if (enc.error) return enc.error;
  const dry = !!(input && input.dryRun === true);
  const now = input && input.now instanceof Date ? new Date(input.now.getTime()) : new Date();
  const d0 = dbOr(db);

  return d0.runTransaction(async (t) => {
    const [idxSnap, curSnap] = await Promise.all([t.get(indexRef(d0, v.merchantId)), t.get(credsRef(d0, v.shopId))]);
    const idx = idxSnap && idxSnap.exists ? idxSnap.data() || {} : null;
    if (idx && idx.shopId !== v.shopId) return fail("merchant_owned_by_other_shop", "merchantId นี้ถูกตั้งให้ร้านอื่นแล้ว — 1 merchant ใช้ได้กับ 1 ร้าน");
    const cur = curSnap && curSnap.exists ? curSnap.data() || {} : null;
    if (enc.boxes.apiKey === undefined && !(cur && cur.apiKey)) return fail("bad_input", "ร้านนี้ยังไม่มี apiKey — ครั้งแรกต้องส่ง apiKey มาด้วย");

    const prevMerchant = cur && isSafeId(cur.merchantId) ? cur.merchantId : null;
    const movedFromMerchantId = prevMerchant && prevMerchant !== v.merchantId ? prevMerchant : null;
    const doc = { ...(cur || {}), ...enc.boxes, shopId: v.shopId, merchantId: v.merchantId, updatedAt: now, updatedBy: v.actor };
    if (!cur) doc.createdAt = now;
    if (doc.webhookHmacKey === undefined) doc.webhookHmacKey = null;

    if (!dry) {
      t.set(credsRef(d0, v.shopId), doc);
      t.set(indexRef(d0, v.merchantId), { shopId: v.shopId, merchantId: v.merchantId, updatedAt: now });
      // ดัชนีเก่าชี้ร้านนี้แน่ (prevMerchant มาจาก doc ของร้านนี้เอง)
      if (movedFromMerchantId) t.delete(indexRef(d0, movedFromMerchantId));
    }
    return {
      ok: true,
      shopId: v.shopId,
      merchantId: v.merchantId,
      created: !cur,
      hasApiKey: !!doc.apiKey,
      hasWebhookHmacKey: !!doc.webhookHmacKey,
      movedFromMerchantId,
      dry,
    };
  });
}

module.exports = {
  getShopBeamCreds,
  getShopIdByMerchantId,
  setShopBeamCreds,
  CREDS_COLLECTION,
  INDEX_COLLECTION,
  ENC_KEY_ENV,
  PROVIDER_ID,
  _internal: { encryptSecret, decryptSecret, isSafeId, readEncKey },
};
