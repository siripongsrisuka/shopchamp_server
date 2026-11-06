// pos/gateway/secretBox.js — กล่องเข้ารหัสกุญแจผู้ให้บริการทุกเจ้า (ก้อน 7 · DEV-0001)
//
// ยกท่าจากกุญแจ Beam รายร้านของพี่น้อง (AES-256-GCM · กุญแจใน env ของ Functions · AAD ผูกกล่องกับร้านและช่อง)
//   แล้วใช้กับ **ทุกเจ้า ทุกช่อง `secret:true`** (decision ก้อน 7: ❌ ไม่ยก hash ที่ยิงได้ของ NTT · ❌ ไม่ยก token ดิบของ POSxPay)
//
// กุญแจเข้ารหัส: env `GATEWAY_CRED_ENC_KEY` = base64 ของ 32 ไบต์ · ไม่มี/ผิดรูป = fail-closed ทุกทาง (ไม่มีค่าตั้งต้น)
//   handler รับ `deps.credKey` (base64) แทน env ได้ เพื่อให้ harness และเทสใช้กุญแจทดสอบ · ❌ ห้ามใส่กุญแจจริงในสัญญาหรือเทส
// AAD = `shopchamp-gw:<providerId>:<field>:<shopId>` ⇒ กล่องของร้าน A วางในเอกสารร้าน B ถอดไม่ออก · ย้ายข้ามช่องก็ถอดไม่ออก
// รูปกล่อง: { alg:"aes-256-gcm", iv, tag, ct } (base64 ทั้ง 3) · ไม่มีค่าลับใน error · ❌ ไม่ log ค่าใด ๆ
"use strict";

const crypto = require("crypto");

const ENC_KEY_ENV = "GATEWAY_CRED_ENC_KEY";
const ALG = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

const err = (code, message) => ({ error: { code, message } });

/**
 * readKey({deps, env}) → {key:Buffer} | {error:{code,message}}
 *   ลำดับ: deps.credKey (base64) → env[GATEWAY_CRED_ENC_KEY] · ทั้งคู่ไม่มี = gateway_cred_key_missing
 */
function readKey({ deps, env } = {}) {
  const fromDeps = deps && typeof deps.credKey === "string" ? deps.credKey : undefined;
  const e = env || process.env;
  const raw = (fromDeps !== undefined ? fromDeps : typeof e[ENC_KEY_ENV] === "string" ? e[ENC_KEY_ENV] : "").trim();
  if (!raw) return err("gateway_cred_key_missing", `ยังไม่ได้ตั้ง ${ENC_KEY_ENV}`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return err("gateway_cred_key_invalid", `${ENC_KEY_ENV} ต้องเป็น base64`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) return err("gateway_cred_key_invalid", `${ENC_KEY_ENV} ต้องเป็นกุญแจ ${KEY_BYTES} ไบต์พอดี`);
  return { key };
}

const aadOf = ({ providerId, field, shopId }) => Buffer.from(`shopchamp-gw:${providerId}:${field}:${shopId}`, "utf8");

function assertBinding(b) {
  for (const k of ["providerId", "field", "shopId"]) {
    if (typeof (b && b[k]) !== "string" || !b[k]) throw new TypeError(`secretBox: ต้องระบุ ${k}`);
  }
}

/** isBox(v) — รูปกล่องครบ (ไม่ได้แปลว่าถอดได้) */
function isBox(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) && v.alg === ALG && ["iv", "tag", "ct"].every((k) => typeof v[k] === "string" && v[k] !== "");
}

/**
 * seal(plain, {providerId, field, shopId}, {key}) → {box} | {error}
 *   key = Buffer จาก readKey · plain ต้องเป็น string
 */
function seal(plain, binding, { key } = {}) {
  assertBinding(binding);
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) return err("gateway_cred_key_invalid", "กุญแจเข้ารหัสไม่ถูกรูป");
  if (typeof plain !== "string") return err("bad_secret", "ค่าลับต้องเป็นข้อความ");
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  cipher.setAAD(aadOf(binding));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { box: { alg: ALG, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") } };
}

/**
 * open(box, {providerId, field, shopId}, {key}) → {plain} | {error}
 *   กล่องผิดรูป · แท็กไม่ตรง · AAD ไม่ตรง (ย้ายข้ามร้าน/ช่อง) · กุญแจเปลี่ยน = gateway_cred_unreadable (ไม่ throw)
 */
function open(box, binding, { key } = {}) {
  assertBinding(binding);
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) return err("gateway_cred_key_invalid", "กุญแจเข้ารหัสไม่ถูกรูป");
  if (!isBox(box)) return err("gateway_cred_unreadable", "กล่องกุญแจผิดรูป");
  try {
    const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(box.iv, "base64"));
    decipher.setAAD(aadOf(binding));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(box.ct, "base64")), decipher.final()]).toString("utf8");
    return { plain };
  } catch (_e) {
    return err("gateway_cred_unreadable", "ถอดกุญแจของร้านไม่ได้ (กุญแจเข้ารหัสเปลี่ยน หรือกล่องถูกย้ายข้ามร้าน)");
  }
}

module.exports = { readKey, seal, open, isBox, ENC_KEY_ENV, ALG };
