// pos/gateway/pairing.js — ร้านจับคู่/ตัดเครื่องรับเงินเอง + ทะเบียนเจ้าของเครื่อง (ก้อน 7 · DEV-0001 · ยกท่าจากบ้านพี่น้อง)
//
// สัญญา: shopchamp-center/api/payment.pair.yaml · payment.unpair.yaml
// route (function pos_gateway): POST /pos_gateway/payment/pair · /payment/unpair
// รูป: factory (deps) => handler(req, res) · deps: now credKey env registry + ตัวแทนผู้ให้บริการ pair unpair
// สิทธิ์: เจ้าของร้านเท่านั้น (ทีมงาน byAdmin ได้ role owner)
//
// กฎเหล็ก (ยกจากพี่น้องทุกข้อ):
//   ① คำตอบไม่มีค่าการเชื่อมต่อ — รหัสเชื่อมต่อเต็มคืนครั้งเดียวตอนจับคู่สำเร็จ (ร้านเพิ่งได้มาเอง)
//      `_status.pairedDevice` เก็บแค่ 4 ตัวท้าย · ค่าเต็มอยู่ gatewayCreds/{shopId}[providerId] (client อ่านไม่ได้ · rules ก้อน 6)
//   ② ล้ม = ไม่เขียนฐานสักช่อง: ตรวจ → อ่านค่าเดิม/ทะเบียน (ปัดก่อนแตะเจ้า) → ยิงเจ้า → ผ่านแล้วค่อยเขียน
//   ③ ค่า + สถานะ + ทะเบียนเจ้าของ (`beamBoltConnections/{id}`) = transaction เดียว · อ่านทะเบียนซ้ำใน transaction เสมอ
//   ④ สวิตช์ช่องทางของร้านคงเดิมทั้ง pair และ unpair
//   ⑤ unpair = ทางล้างค่าที่ตั้งใจ (ลบช่อง ownership ออกจากก้อน · ลบแถวทะเบียน)
// แกนกลางไม่รู้จักชื่อเจ้า: อ่าน spec.connection.ownership ผ่าน registry.ownershipOf · ความสามารถผ่าน registry.canPairOf
// ของยุคก่อน (ร้านถือค่าแต่ทะเบียนไม่มีแถว) = ถือว่าเป็นเจ้าของ · ค่าที่ทะเบียนบอกว่าเป็นของร้านอื่น = ตัดไม่ได้ แต่จับคู่เครื่องตัวเองทับได้
// แอปเก่า: ไม่เห็นอะไรเปลี่ยน (เส้นใหม่ · collection ใหม่)
"use strict";

const { PaymentPairRequest, PaymentUnpairRequest } = require("@shopchamp/schema");
const { ok, fail, deny, sendDeny, parseOr400 } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, isOwner, adminTrail, adminFlag } = require("../_shared/auth");
const CS = require("./credStore");
const C = require("./connections")._internal;

const { STATUS_KEY, OWNED_BY_OTHER, AbortTx, asObj, isSafeDocId } = C;

/** 4 ตัวท้ายของรหัส — สิ่งเดียวที่ `_status` เก็บและจอเห็นหลังจับคู่ */
const tailOf = (id) => String(id).slice(-4);

/** รหัสของเจ้าที่ร้านแก้เองได้ = ส่งข้อความของเจ้าต่อ (สถานะตามความหมาย) · นอกนั้น 502 ข้อความกลาง */
const PROVIDER_ERRORS = Object.freeze({
  pairing_code_rejected: 422,
  beam_merchant_not_configured: 409,
  beam_credentials_invalid: 502,
});

function providerFailure(res, result, fallbackMessage) {
  const e = asObj(result && result.error);
  const code = C.providerCodeOf(e);
  if (code && PROVIDER_ERRORS[code]) {
    const msg = code === "beam_merchant_not_configured" ? "ร้านนี้ยังไม่ได้เปิดบัญชีรับเงิน Beam — ติดต่อทีมงาน Shopchamp" : C.redact(e.message, {}) || fallbackMessage;
    return fail(res, PROVIDER_ERRORS[code], code, msg);
  }
  return fail(res, 502, "provider_error", fallbackMessage, { providerCode: code || undefined, providerStatus: Number.isFinite(e.status) ? e.status : undefined });
}

/** ด่านร่วม 2 เส้น → {access, input, reg, mod, spec, ownership} | ส่งคำตอบแล้วคืน null */
function prepare(req, res, deps, schema) {
  const body = asObj(req && req.body);
  const gate = callerAccess(req, body.shopId);
  if (!gate.ok) { sendDeny(res, gate); return null; }
  const access = gate.access;
  if (!isOwner(access)) { sendDeny(res, deny(403, "owner_required")); return null; }
  const input = parseOr400(schema, body, res);
  if (!input) return null;
  const reg = C.registryOf(deps);
  const r = C.resolveProvider(reg, input.providerId);
  if (!r.ok) { sendDeny(res, r); return null; }
  if (!reg.canPairOf(r.mod)) { fail(res, 400, "pair_not_supported", `${r.spec.id} ไม่รองรับการจับคู่เครื่องจากจอตั้งค่า`); return null; }
  const ownership = reg.ownershipOf(r.spec);
  // ทะเบียนบังคับคู่กันอยู่แล้ว — ถึงตรงนี้ = ทะเบียนถูกข้าม ⇒ ดัง ไม่เดินต่อ
  if (!ownership) throw new Error(`gateway/pairing: เจ้า ${r.spec.id} มี pair/unpair แต่ไม่ประกาศ connection.ownership`);
  return { access, input, reg, mod: r.mod, spec: r.spec, ownership };
}

/** ค่าปัจจุบันของช่อง ownership (ถอดกล่องแล้วถ้าเป็นช่องลับ) · "" = ไม่มี */
async function currentValue({ db, deps, spec, shopId, ownership }) {
  const cfg = await C.loadConfig({ db, deps, spec, shopId });
  if (!cfg.ok) return cfg;
  const v = cfg.values[ownership.field];
  return { ok: true, current: typeof v === "string" ? v.trim() : "" };
}

/** ทะเบียนบอกว่าค่านี้เป็นของใคร · ค่าที่เป็น doc id ไม่ได้ = ถือว่าไม่มีทะเบียน (ร้านต้องล้างค่านั้นได้) */
async function ownerOf(db, ownership, value) {
  if (!isSafeDocId(value)) return { exists: false, shopId: null };
  return C.readOwner((ref) => ref.get(), db, ownership, value);
}

/** ก้อนค่าใหม่ของเจ้า (ใช้ mergeFields ⇒ ช่องลับถูกเข้ารหัสเหมือนเส้น testAndSave) */
function mergedBlock({ deps, spec, shopId, block, incoming }) {
  const needKey = C.fieldsOf(spec).some((f) => f.secret === true);
  const k = needKey ? C.credKeyOf(deps) : { key: null };
  const m = CS.mergeFields({ spec, shopId, block, incoming, key: k.key });
  if (!m.ok) throw new AbortTx(m.code, m.message);
  return m.block;
}

// ── ① pair ────────────────────────────────────────────────────────────────────
function pair(deps) {
  return async function handler(req, res) {
    let p;
    try {
      p = prepare(req, res, deps, PaymentPairRequest);
      if (!p) return undefined;
      const { access, input, mod, spec, ownership } = p;
      const shopId = access.shopId;
      const { db } = require("../../firebase");
      const now = await readNow(deps);
      // เครื่องแสดงตัวพิมพ์ใหญ่ · ร้านพิมพ์เล็กมาก็ให้ผ่าน
      const pairingCode = input.pairingCode.trim().toUpperCase();

      const cur = await currentValue({ db, deps, spec, shopId, ownership });
      if (!cur.ok) return C.credFailure(res, cur);
      if (cur.current) {
        const owner = await ownerOf(db, ownership, cur.current);
        // ไม่มีทะเบียน (ยุคก่อน) หรือเป็นของเรา = มีเครื่องอยู่แล้วจริง ⇒ ต้องตัดก่อน
        if (!owner.exists || owner.shopId === shopId) {
          return fail(res, 409, "already_paired", `ร้านนี้จับคู่กับเครื่องอยู่แล้ว (รหัสลงท้าย …${tailOf(cur.current)}) — ตัดการเชื่อมต่อเครื่องเดิมก่อน`);
        }
      }

      const pairFn = C.providerFn(deps, mod, "pair");
      let result;
      try {
        result = await pairFn({ pairingCode, shopId, ...C.extrasOf(deps) });
      } catch (e) {
        try { console.error("gateway pair provider_threw", spec.id, e && e.name); } catch (_) { /* ไม่ล้มคำตอบ */ }
        return fail(res, 502, "provider_error", "จับคู่เครื่องไม่สำเร็จ ลองใหม่อีกครั้ง");
      }
      if (!result || result.ok !== true || !result.data) {
        return providerFailure(res, result, "จับคู่เครื่องไม่สำเร็จ ลองใหม่อีกครั้ง — ถ้ายังไม่ได้ให้แจ้งทีมงาน Shopchamp");
      }
      const id = typeof result.data[ownership.field] === "string" ? result.data[ownership.field].trim() : "";
      if (!id || !isSafeDocId(id)) {
        return fail(res, 502, "bad_response", "ผู้ให้บริการตอบว่าจับคู่สำเร็จแต่รหัสเชื่อมต่อใช้ไม่ได้ — ลองจับคู่ใหม่ หรือแจ้งทีมงาน Shopchamp");
      }
      const str = (v) => (typeof v === "string" && v ? v : null);
      const deviceId = str(result.data.deviceId);
      const merchantId = str(result.data.merchantId);
      const verifiedFields = [ownership.field];
      const verifiedLevel = C.deriveVerifiedLevel({ requiredKeys: C.requiredKeysOf(spec), verifiedFields, tested: true });
      const verifiedNote = `จับคู่เครื่องสำเร็จ${deviceId ? ` (เครื่อง ${deviceId})` : ""} — ผู้ให้บริการยืนยันรหัสจับคู่และออกรหัสเชื่อมต่อให้ร้านนี้ · ยังไม่ได้พิสูจน์: เครื่องเปิดอยู่ไหม · รูดขายได้จริงไหม`;
      const trail = adminTrail(access);

      try {
        await db.runTransaction(async (tx) => {
          const cRef = CS.credsRef(db, shopId);
          const sRef = CS.statusRef(db, shopId);
          const regRef = C.ownerRef(db, ownership, id);
          const cSnap = await tx.get(cRef);
          const sSnap = await tx.get(sRef);
          const regSnap = await tx.get(regRef);
          const block = asObj(asObj(cSnap.exists ? cSnap.data() : {})[spec.id]);
          // ค่าที่ถืออยู่ตอนเขียน (อีกจอกดพร้อมกัน / ค่าเก่าจากรูเดิม) — อ่านทะเบียนของค่านั้นก่อนตัดสิน
          const cfgNow = CS.openConfig({ spec, shopId, block, key: C.fieldsOf(spec).some((f) => f.secret) ? C.credKeyOf(deps).key : null });
          const held = cfgNow.ok && typeof cfgNow.values[ownership.field] === "string" ? cfgNow.values[ownership.field].trim() : "";
          if (held && held !== id) {
            if (!isSafeDocId(held)) throw new AbortTx("already_paired", "ร้านนี้จับคู่กับเครื่องอยู่แล้ว — ตัดการเชื่อมต่อเครื่องเดิมก่อน");
            const heldSnap = await tx.get(C.ownerRef(db, ownership, held));
            const heldOwner = heldSnap && heldSnap.exists ? asObj(heldSnap.data()).shopId : null;
            if (!heldSnap || !heldSnap.exists || heldOwner === shopId) {
              throw new AbortTx("already_paired", "ร้านนี้เพิ่งจับคู่กับเครื่องอื่นไปแล้ว — ตัดการเชื่อมต่อเครื่องนั้นก่อน");
            }
          }
          if (regSnap && regSnap.exists && asObj(regSnap.data()).shopId !== shopId) {
            throw new AbortTx(OWNED_BY_OTHER.code, OWNED_BY_OTHER.message);
          }
          const nextBlock = mergedBlock({ deps, spec, shopId, block, incoming: { [ownership.field]: id } });
          const statusDoc = sSnap.exists ? asObj(sSnap.data()) : {};
          const prevBlock = asObj(statusDoc[spec.id]);
          const prevStatus = asObj(prevBlock[STATUS_KEY]);
          const nextStatus = {
            verifiedAt: now, verifiedLevel, verifiedNote, verifiedFields,
            channels: asObj(prevStatus.channels), // ④
            pairedDevice: { deviceId, pairedAt: now, boltConnectionIdTail: tailOf(id) }, // ① ไม่มีรหัสเต็ม
          };
          const regData = { shopId, providerId: spec.id, deviceId, pairedAt: now, ...trail };
          if (merchantId) regData.merchantId = merchantId;
          tx.set(regRef, regData);
          const credsPatch = { [spec.id]: nextBlock, updatedAt: now, updatedBy: access.uid, ...trail };
          if (cSnap.exists) tx.update(cRef, credsPatch);
          else tx.set(cRef, credsPatch);
          const statusPatch = { [spec.id]: { ...prevBlock, [STATUS_KEY]: nextStatus } };
          if (sSnap.exists) tx.update(sRef, statusPatch);
          else tx.set(sRef, statusPatch);
        });
      } catch (e) {
        if (e instanceof AbortTx) return e.code === OWNED_BY_OTHER.code || e.code === "already_paired" ? fail(res, 409, e.code, e.message) : C.credFailure(res, e);
        throw e;
      }
      return ok(res, { providerId: spec.id, [ownership.field]: id, deviceId, pairedAt: now.toISOString(), verifiedLevel, ...adminFlag(access) });
    } catch (e) {
      try { console.error("gateway pair error", e && e.name, e && e.message); } catch (_) { /* ไม่ล้มคำตอบ */ }
      return fail(res, 500, "internal_error");
    }
  };
}

// ── ② unpair ──────────────────────────────────────────────────────────────────
function unpair(deps) {
  return async function handler(req, res) {
    try {
      const p = prepare(req, res, deps, PaymentUnpairRequest);
      if (!p) return undefined;
      const { access, mod, spec, ownership } = p;
      const shopId = access.shopId;
      const { db } = require("../../firebase");
      const now = await readNow(deps);

      const cur = await currentValue({ db, deps, spec, shopId, ownership });
      if (!cur.ok) return C.credFailure(res, cur);
      if (!cur.current) return fail(res, 409, "not_paired", "ร้านนี้ยังไม่ได้จับคู่เครื่อง — ไม่มีอะไรให้ตัด");
      // เจ้าของเท่านั้นที่ตัดได้ — ทะเบียนบอกว่าเป็นของร้านอื่น = ปัดโดยไม่แตะเจ้า
      const owner = await ownerOf(db, ownership, cur.current);
      if (owner.exists && owner.shopId !== shopId) return fail(res, 409, OWNED_BY_OTHER.code, OWNED_BY_OTHER.message);

      const unpairFn = C.providerFn(deps, mod, "unpair");
      let result;
      try {
        result = await unpairFn({ [ownership.field]: cur.current, shopId, ...C.extrasOf(deps) });
      } catch (e) {
        try { console.error("gateway unpair provider_threw", spec.id, e && e.name); } catch (_) { /* ไม่ล้มคำตอบ */ }
        return fail(res, 502, "provider_error", "ตัดการเชื่อมต่อไม่สำเร็จ ลองใหม่อีกครั้ง");
      }
      if (!result || result.ok !== true) return providerFailure(res, result, "ตัดการเชื่อมต่อไม่สำเร็จ ลองใหม่อีกครั้ง — ถ้ายังไม่ได้ให้แจ้งทีมงาน Shopchamp");
      const alreadyGone = !!(result.data && result.data.alreadyGone === true);
      const trail = adminTrail(access);

      try {
        await db.runTransaction(async (tx) => {
          const cRef = CS.credsRef(db, shopId);
          const sRef = CS.statusRef(db, shopId);
          const regRef = isSafeDocId(cur.current) ? C.ownerRef(db, ownership, cur.current) : null;
          const cSnap = await tx.get(cRef);
          const sSnap = await tx.get(sRef);
          const regSnap = regRef ? await tx.get(regRef) : null;
          const block = asObj(asObj(cSnap.exists ? cSnap.data() : {})[spec.id]);
          const cfgNow = CS.openConfig({ spec, shopId, block, key: C.fieldsOf(spec).some((f) => f.secret) ? C.credKeyOf(deps).key : null });
          const held = cfgNow.ok && typeof cfgNow.values[ownership.field] === "string" ? cfgNow.values[ownership.field].trim() : "";
          // อีกจอเปลี่ยนค่าไปแล้วระหว่างทาง — ห้ามล้างของที่ไม่ใช่ตัวที่เพิ่งตัดที่เจ้า
          if (held !== cur.current) throw new AbortTx("state_changed", "ข้อมูลการเชื่อมต่อเปลี่ยนระหว่างทาง — โหลดหน้าจอใหม่แล้วลองอีกครั้ง");
          if (regSnap && regSnap.exists) {
            if (asObj(regSnap.data()).shopId !== shopId) throw new AbortTx(OWNED_BY_OTHER.code, OWNED_BY_OTHER.message);
            tx.delete(regRef);
          }
          const nextBlock = { ...block };
          delete nextBlock[ownership.field]; // ⑤ ทางล้างค่าที่ตั้งใจ
          tx.update(cRef, { [spec.id]: nextBlock, updatedAt: now, updatedBy: access.uid, ...trail });
          const statusDoc = sSnap.exists ? asObj(sSnap.data()) : {};
          const prevBlock = asObj(statusDoc[spec.id]);
          const prevStatus = asObj(prevBlock[STATUS_KEY]);
          const rest = { ...prevStatus };
          delete rest.pairedDevice;
          const nextStatus = {
            ...rest,
            verifiedAt: now,
            verifiedLevel: C.deriveVerifiedLevel({ requiredKeys: C.requiredKeysOf(spec), verifiedFields: [], tested: true }),
            verifiedFields: [],
            verifiedNote: `ตัดการเชื่อมต่อเครื่องแล้ว${alreadyGone ? " (ผู้ให้บริการไม่พบการเชื่อมต่อนี้อยู่แล้ว)" : ""} — ยังไม่มีเครื่องที่จับคู่`,
            channels: asObj(prevStatus.channels), // ④
          };
          const statusPatch = { [spec.id]: { ...prevBlock, [STATUS_KEY]: nextStatus } };
          if (sSnap.exists) tx.update(sRef, statusPatch);
          else tx.set(sRef, statusPatch);
        });
      } catch (e) {
        if (e instanceof AbortTx) return fail(res, 409, e.code, e.message);
        throw e;
      }
      return ok(res, { providerId: spec.id, unpaired: true, alreadyGone, ...adminFlag(access) });
    } catch (e) {
      try { console.error("gateway unpair error", e && e.name, e && e.message); } catch (_) { /* ไม่ล้มคำตอบ */ }
      return fail(res, 500, "internal_error");
    }
  };
}

module.exports = { pair, unpair, _internal: { tailOf, PROVIDER_ERRORS, providerFailure, prepare, currentValue, ownerOf } };
