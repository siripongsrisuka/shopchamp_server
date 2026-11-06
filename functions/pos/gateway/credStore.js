// pos/gateway/credStore.js — ที่เก็บค่าการเชื่อมต่อของร้านกับผู้ให้บริการ (ก้อน 7 · DEV-0001)
//
// แบ่ง 2 ที่ (decision ก้อน 7 · rules ก้อน 6 ปิด client ทั้งอ่านและเขียนทั้ง 2 collection):
//   `gatewayCreds/{shopId}`                 = { [providerId]: { [fieldKey]: ค่า | กล่องเข้ารหัส }, updatedAt, updatedBy }
//      ช่อง `secret:true` ในทะเบียน = กล่อง secretBox เสมอ · ช่องอื่นเก็บข้อความตรง (TID merchantId serial ไม่ใช่ความลับ)
//   `shop/{shopId}/meta/paymentGateway`     = { [providerId]: { _status: {verifiedAt, verifiedLevel, verifiedNote, verifiedFields, channels:{[channelId]:{enabled, open, checkedAt}}} } }
//      ไม่มีค่าการเชื่อมต่อสักช่อง (แบบพี่น้องเก็บกุญแจไว้ที่นี่และ rules เปิดให้ทุกบัญชีอ่าน · ไม่ยก)
//   กุญแจ Beam ทีมงานกรอก (Pack เคาะ 2026-11-06 ข้อ 3 · `shopchampoffice`) อยู่ `beamMerchantCreds/{shopId}` แยก (ดู providers/beam)
//
// กติกาที่ยกมาตรงตัว:
//   ① ชื่อช่องที่ provider ได้รับ = `spec.connection.fields[].key` เป๊ะ
//   ② ค่าที่ provider ได้รับ = ค่าที่ร้านกรอก (ถอดกล่องแล้ว) · ไม่มี hash ที่ยิงได้ · provider แปลงเองตอนยิงถ้าเจ้าต้องการ
//   ③ ช่องไม่บังคับที่ไม่ได้กรอก = ไม่มี key ใน config เลย
//   ④ testAndSave: ช่องที่ไม่ส่งมา = ไม่ทับค่าเดิม · ส่ง "" = ล้างช่องนั้น
"use strict";

const SB = require("./secretBox");

const CREDS_COLLECTION = "gatewayCreds";
const STATUS_DOC = ["meta", "paymentGateway"];
const STATUS_KEY = "_status";
const STATIONS_COLLECTION = "gatewayStations";

const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const fieldsOf = (spec) => (spec && spec.connection && Array.isArray(spec.connection.fields) ? spec.connection.fields : []);
const isFilled = (v) => typeof v === "string" ? v !== "" : SB.isBox(v);

function credsRef(db, shopId) {
  return db.collection(CREDS_COLLECTION).doc(shopId);
}
function statusRef(db, shopId) {
  return db.collection("shop").doc(shopId).collection(STATUS_DOC[0]).doc(STATUS_DOC[1]);
}
function stationsRef(db, shopId) {
  return db.collection(STATIONS_COLLECTION).doc(shopId);
}

/**
 * openConfig({spec, shopId, block, key}) → {ok:true, values} | {ok:false, code, message}
 *   block = `gatewayCreds/{shopId}[spec.id]` (ดิบ) · values = config ที่ provider ใช้ (กติกา ① ② ③)
 *   ช่องลับที่ไม่ใช่กล่อง (ใครเขียนค่าดิบไว้) = gateway_cred_unreadable (ไม่ใช้ค่าดิบ · fail-closed)
 */
function openConfig({ spec, shopId, block, key }) {
  const b = asObj(block);
  const values = {};
  for (const f of fieldsOf(spec)) {
    const v = b[f.key];
    if (v === undefined || v === null || v === "") continue;
    if (f.secret) {
      if (!key) return { ok: false, code: "gateway_cred_key_missing", message: "ยังไม่ได้ตั้งกุญแจเข้ารหัสของระบบ" };
      const o = SB.open(v, { providerId: spec.id, field: f.key, shopId }, { key });
      if (o.error) return { ok: false, code: o.error.code, message: o.error.message };
      values[f.key] = o.plain;
    } else if (typeof v === "string") {
      values[f.key] = v;
    }
  }
  return { ok: true, values };
}

/**
 * mergeFields({spec, shopId, block, incoming, key}) → {ok:true, block, values} | {ok:false, code, message, keys?}
 *   รวมค่าเดิมกับค่าที่ร้านส่ง (กติกา ④) · block = รูปที่จะเขียนลง gatewayCreds (ช่องลับเป็นกล่องใหม่) · values = ค่าดิบไว้ทดสอบ
 *   ช่องที่ไม่รู้จัก = unknown_field (บอกชื่อ ไม่บอกค่า) · ค่าไม่ใช่ข้อความ = bad_input
 */
function mergeFields({ spec, shopId, block, incoming, key }) {
  const known = new Map(fieldsOf(spec).map((f) => [f.key, f]));
  const inc = asObj(incoming);
  const unknown = Object.keys(inc).filter((k) => !known.has(k));
  if (unknown.length) return { ok: false, code: "unknown_field", message: `ไม่รู้จักช่อง: ${unknown.join(", ")}`, keys: unknown };
  const badType = Object.keys(inc).filter((k) => typeof inc[k] !== "string");
  if (badType.length) return { ok: false, code: "bad_input", message: `ค่าของช่องต้องเป็นข้อความ: ${badType.join(", ")}`, keys: badType };

  const opened = openConfig({ spec, shopId, block, key });
  if (!opened.ok) {
    // ช่องลับเดิมถอดไม่ได้ แต่ร้านส่งค่าใหม่มาทับทุกช่องลับที่มีอยู่ = ใช้ได้ (ทางกู้เมื่อกุญแจเปลี่ยน)
    const oldSecrets = fieldsOf(spec).filter((f) => f.secret && isFilled(asObj(block)[f.key]));
    if (!oldSecrets.every((f) => typeof inc[f.key] === "string")) return opened;
  }
  const values = {};
  const out = {};
  for (const [k, f] of known) {
    const raw = Object.prototype.hasOwnProperty.call(inc, k) ? inc[k].trim() : undefined;
    const cur = raw !== undefined ? raw : opened.ok ? opened.values[k] : undefined;
    if (cur === undefined || cur === "") continue;
    values[k] = cur;
    if (f.secret) {
      if (raw === undefined && SB.isBox(asObj(block)[k])) { out[k] = asObj(block)[k]; continue; } // ไม่ส่งมา = คงกล่องเดิม (ไม่เข้ารหัสใหม่)
      if (!key) return { ok: false, code: "gateway_cred_key_missing", message: "ยังไม่ได้ตั้งกุญแจเข้ารหัสของระบบ" };
      const s = SB.seal(cur, { providerId: spec.id, field: k, shopId }, { key });
      if (s.error) return { ok: false, code: s.error.code, message: s.error.message };
      out[k] = s.box;
    } else {
      out[k] = cur;
    }
  }
  return { ok: true, block: out, values };
}

/**
 * fieldStateOf({spec, block}) → [{key, secret, required, set}] · ไม่มีค่าใด ๆ ออกไป (ช่องไม่ลับก็ไม่คืน · จอเริ่มว่างทุกครั้ง)
 */
function fieldStateOf({ spec, block }) {
  const b = asObj(block);
  return fieldsOf(spec).map((f) => ({ key: f.key, secret: !!f.secret, required: !!f.required, set: isFilled(b[f.key]) }));
}

/** statusOf(statusDoc, providerId) → `_status` ของเจ้านั้น หรือ null */
function statusOf(statusDoc, providerId) {
  const blk = asObj(asObj(statusDoc)[providerId]);
  const st = blk[STATUS_KEY];
  return st && typeof st === "object" && !Array.isArray(st) ? st : null;
}

module.exports = {
  CREDS_COLLECTION, STATUS_KEY, STATIONS_COLLECTION,
  credsRef, statusRef, stationsRef, openConfig, mergeFields, fieldStateOf, statusOf, isFilled,
};
