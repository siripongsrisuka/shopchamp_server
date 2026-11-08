// pos/gateway/requestQr — ขอ QR / สั่งเครื่องของผู้ให้บริการผ่าน server (ก้อน 7 · DEV-0001)
//
// สัญญา: shopchamp-center/api/payment.requestQr.yaml · route POST /pos_gateway/payment/request-qr (ยังไม่ผูก index.js · ยังไม่ deploy)
// ยกจากครึ่ง request-qr ของพี่น้อง (`claude/payment/acquirer.js`) · ตัดออก: autoCheckout · receiptData · remotePay · extra · fallback ร้าน NTT
//   ⇒ แอปสร้างบิลเองหลังรู้ผล (decision 3-2) · ไฟล์นี้ไม่รู้จักชื่อช่องของเจ้าไหนเลย (config = ก้อนทึบตาม spec.connection.fields)
// รูป: factory (deps) => handler(req, res)
//   deps (ไม่ส่งได้ทุกตัว): now · credKey (base64) · env (object แทน process.env ทั้งก้อน) · newReferenceId (sync → string)
//     createQR / inquiry = ใช้แทนฟังก์ชันของเจ้า (args ก้อนเดียวกัน) ⇒ harness ไม่ยิงเน็ต
//     registry = ทะเบียนเจ้าแทน `./providers` (object · เทสข้างไฟล์ใช้ · harness ใช้ทะเบียนจริง)
//
// ลำดับ:
//   ① callerAccess → 401 no_shop_access / 403 wrong_shop   ② Zod PaymentRequestQrRequest → 400 invalid_request
//   ③ ทะเบียน: ไม่รู้จัก = 400 unknown_channel · เจ้า runtime device = 400 channel_not_server_runtime (ไม่แตะฐาน)
//   ③' แพ็กเกจ Payment Gateway ไม่มี/หมด = 403 package_required (packageGate.js · ไม่อ่านค่าเชื่อมต่อ ไม่เขียน)
//   ④ อ่าน `shop/{shopId}/meta/paymentGateway` (สถานะ) + `gatewayCreds/{shopId}` (ค่าเชื่อมต่อ)
//      ผลตรวจกระเป๋าของร้านชนะทะเบียน → ยังไม่เปิด = 400 unknown_channel
//      ถอด config (ช่องลับ = กล่อง secretBox) · ช่องบังคับขาด = 409 gateway_not_configured {missing: ชื่อช่องเท่านั้น}
//      เจ้า at-bill (beam-bolt) ต้องมีสวิตช์ร้าน `_status.channels[ch].enabled === true` ไม่งั้น 409 channel_not_enabled_for_shop
//   ⑤ กันกดซ้ำ (มี clientRequestId): หา pgWebhook ร้านนี้ + clientRequestId + channelId + ยอด ภายใน 15 นาที
//      ใบที่จ่ายแล้ว (success) = 409 already_paid · ใบที่ยังรอ = ถามผู้ให้บริการก่อน: waiting → คืนใบเดิม (reused:true)
//      paid → 409 already_paid · อย่างอื่น/ถามไม่ได้ → ออกใบใหม่
//   ⑥ เขียน pgWebhook/{referenceId} **ก่อน** ยิงผู้ให้บริการ (process:'request') → createQR → update ผลลงใบ
//      ผู้ให้บริการล้ม = 502 provider_error (ข้อความผ่าน redact · ใบคงอยู่แบบไม่มี providerRef เหมือนพี่น้อง)
"use strict";

const crypto = require("crypto");
const { PaymentRequestQrRequest } = require("@shopchamp/schema");
const { ok, fail, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow, depOr } = require("../_shared/deps");
const { callerAccess, adminTrail, adminFlag } = require("../_shared/auth");
const CS = require("./credStore");
const SB = require("./secretBox");
const { COLLECTION, toSatang, sameSatang } = require("./settle");
const PG = require("./packageGate");

const REUSE_WINDOW_MS = 15 * 60 * 1000; // หน้าต่างกันกดซ้ำ (เท่าพี่น้อง)
const REUSE_SCAN_LIMIT = 10;

// ── ของใช้ร่วมของ handler เกตเวย์ฝั่งแอป (inquire · cancelQr · simulate · deviceSaleRecord เรียกผ่าน _internal) ──

/** ทะเบียนเจ้า: deps.registry (เทส) หรือ `./providers` (โหลดตอนเรียก · ไม่โหลดตอนโหลดไฟล์) */
function registryOf(deps) {
  const r = deps && deps.registry;
  if (r !== undefined && r !== null) {
    if (typeof r !== "object") throw new TypeError("deps.registry ต้องเป็น object");
    return r;
  }
  return require("./providers");
}

/** env ที่ handler อ่าน: deps.env (ทั้งก้อน) หรือ process.env */
function envOf(deps) {
  return deps && deps.env && typeof deps.env === "object" ? deps.env : process.env;
}

/**
 * ฟังก์ชันของเจ้า: deps[name] ชนะ (harness/เทส) · ไม่มีทั้งคู่ = null
 *   ส่ง deps.credKey / deps.env ต่อใน args ทุกครั้งที่มี (beam-bolt ถอดกุญแจรายร้านเองด้วย credKey · อ่าน env ต่อคำขอ)
 */
function providerFn(deps, provider, name) {
  const override = depOr(deps, name, null);
  const fn = override || (provider && typeof provider[name] === "function" ? (args) => provider[name](args) : null);
  if (!fn) return null;
  const pass = {};
  if (deps && typeof deps.credKey === "string" && deps.credKey) pass.credKey = deps.credKey;
  if (deps && deps.env && typeof deps.env === "object") pass.env = deps.env;
  return (args) => fn({ ...args, ...pass });
}

const firstStr = (v) => (typeof v === "string" && v ? v : null);

/**
 * กันข้อความ error ของผู้ให้บริการพ่นค่าเชื่อมต่อกลับไปที่จอ (ยกจากพี่น้อง)
 * ค่าที่ยาว ≥ 4 ตัวในก้อน config ถูกแทนด้วย «ปกปิด» · ตัดยาว 300
 */
function redact(text, config) {
  let out = typeof text === "string" ? text : "";
  for (const v of Object.values(config || {})) {
    const s = String(v);
    if (s.length >= 4 && out.includes(s)) out = out.split(s).join("«ปกปิด»");
  }
  return out.slice(0, 300);
}

/**
 * loadConfig({db, deps, shopId, spec}) → {ok:true, config, statusDoc} | {ok:false, status, error, message, extra?}
 *   อ่าน gatewayCreds/{shopId} + shop/{shopId}/meta/paymentGateway · ถอดกล่องด้วยกุญแจของระบบ
 *   ช่องบังคับขาด = 409 gateway_not_configured {missing} (ชื่อช่องเท่านั้น ไม่มีค่า)
 *   กล่องถอดไม่ได้ = 409 gateway_cred_unreadable (ร้านกรอกใหม่) · ไม่มีกุญแจระบบ = 500 gateway_cred_key_missing
 */
async function loadConfig({ db, deps, shopId, spec, statusDoc }) {
  const [credSnap, stSnap] = await Promise.all([
    CS.credsRef(db, shopId).get(),
    statusDoc === undefined ? CS.statusRef(db, shopId).get() : Promise.resolve(null),
  ]);
  const st = statusDoc !== undefined ? statusDoc : stSnap && stSnap.exists ? stSnap.data() : null;
  const creds = credSnap.exists ? credSnap.data() || {} : {};
  const k = SB.readKey({ deps, env: envOf(deps) });
  const opened = CS.openConfig({ spec, shopId, block: creds[spec.id], key: k.key });
  if (!opened.ok) {
    if (opened.code === "gateway_cred_unreadable") return { ok: false, status: 409, error: opened.code, message: "ถอดค่าการเชื่อมต่อของร้านไม่ได้ กรุณาบันทึกการเชื่อมต่อใหม่" };
    return { ok: false, status: 500, error: "gateway_cred_key_missing", message: "ระบบยังไม่พร้อมใช้การเชื่อมต่อนี้ ติดต่อทีมงาน Shopchamp" };
  }
  const fields = spec && spec.connection && Array.isArray(spec.connection.fields) ? spec.connection.fields : [];
  const missing = fields.filter((f) => f.required && !(f.key in opened.values)).map((f) => f.key);
  if (missing.length) {
    return { ok: false, status: 409, error: "gateway_not_configured", message: `ยังตั้งค่าช่องทางนี้ไม่ครบ ขาด: ${missing.join(", ")}`, extra: { missing } };
  }
  return { ok: true, config: opened.values, statusDoc: st };
}

/** อ่านเวลาเป็น ms (Date · Timestamp · ISO) · อ่านไม่ออก = NaN (ไม่ใช้ซ้ำ) */
function toMillis(ts) {
  if (!ts) return NaN;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") { const d = ts.toDate(); return d instanceof Date ? d.getTime() : NaN; }
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === "string") { const n = Date.parse(ts); return Number.isFinite(n) ? n : NaN; }
  return NaN;
}

/**
 * หาใบเดิมของคำขอเดียวกันภายใน 15 นาที (equality ล้วน · กรองอายุในหน่วยความจำ = ไม่ต้องมี composite index)
 *   คืน {paid: ใบ success ใบใหม่สุด | null, waiting: ใบ request ที่มี qrPayload ใบใหม่สุด | null}
 *   ต่างจากพี่น้อง: ไม่กรอง process ใน query ⇒ เห็นใบที่จ่ายแล้วด้วย (พี่น้องออกใบใหม่ให้จ่ายซ้ำได้เมื่อ webhook mark ไปแล้ว)
 */
async function findSameRequest({ db, shopId, clientRequestId, channelId, amount, nowMs }) {
  const snap = await db
    .collection(COLLECTION)
    .where("shopId", "==", shopId)
    .where("clientRequestId", "==", clientRequestId)
    .where("channelId", "==", channelId)
    .where("amount", "==", amount)
    .limit(REUSE_SCAN_LIMIT)
    .get();
  const out = { paid: null, waiting: null };
  if (!snap || !Array.isArray(snap.docs)) return out;
  const cutoff = nowMs - REUSE_WINDOW_MS;
  let paidAt = -Infinity;
  let waitAt = -Infinity;
  for (const d of snap.docs) {
    const doc = (typeof d.data === "function" && d.data()) || {};
    const at = toMillis(doc.timestamp);
    if (!Number.isFinite(at) || at < cutoff) continue;
    if (doc.process === "success" && at > paidAt) { paidAt = at; out.paid = { referenceId: d.id, doc }; }
    if (doc.process === "request" && doc.qrPayload && at > waitAt) { waitAt = at; out.waiting = { referenceId: d.id, doc }; }
  }
  return out;
}

/**
 * ถามผู้ให้บริการก่อนคืนใบเดิม (พี่น้อง DEV-0888: QR ของธนาคารตายก่อนหน้าต่าง 15 นาทีได้)
 * @returns {'reuse'|'already_paid'|'fresh'} · ถามไม่ได้/ตอบอื่น = fresh (ออก QR เกินมาใบหนึ่ง ≪ ร้านถือ QR ตาย)
 */
async function verifyReusable({ deps, provider, channel, config, shopId, doc }) {
  const inquiry = providerFn(deps, provider, "inquiry");
  if (!doc.providerRef || !inquiry) return "fresh";
  let r;
  try {
    r = await inquiry({ channel, config, providerRef: doc.providerRef, expectedAmount: doc.amount, shopId });
  } catch (e) {
    console.warn("pos gateway requestQr reuse_inquiry_threw", provider.spec.id, redact(e && e.message, config));
    return "fresh";
  }
  if (!r || r.ok !== true || !r.data) return "fresh";
  if (r.data.state === "waiting") return "reuse";
  if (r.data.state === "paid") return "already_paid";
  return "fresh";
}

function newReferenceIdOf(deps) {
  const f = depOr(deps, "newReferenceId", null);
  if (f) {
    const v = f();
    if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v)) throw new TypeError("deps.newReferenceId ต้องคืน referenceId ที่ถูกรูป");
    return v;
  }
  return `pg${crypto.randomBytes(12).toString("hex")}`;
}

const sendFailOf = (res, r) => fail(res, r.status, r.error, r.message, r.extra);

function requestQr(deps) {
  return async function handler(req, res) {
    const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

    const gate = callerAccess(req, body.shopId);
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;
    const input = parseOr400(PaymentRequestQrRequest, body, res);
    if (!input) return undefined;

    let config = {};
    try {
      const registry = registryOf(deps);
      const channelId = input.channelId;
      // ③ ตอบได้โดยไม่แตะฐาน: ไม่รู้จัก · เจ้าที่ไม่ได้ทำงานบน server
      const first = registry.resolveSalesChannel(channelId);
      if (!first.ok && !first.fromRegistry) {
        if (first.reason === "channel_not_server_runtime") {
          return fail(res, 400, "channel_not_server_runtime", "ช่องทางนี้ทำงานที่เครื่องในร้าน ไม่ได้ผ่านเซิร์ฟเวอร์");
        }
        return fail(res, 400, "unknown_channel", "ไม่รู้จักช่องทางนี้ หรือช่องทางนี้ยังไม่เปิดใช้งาน");
      }
      const { provider, channel } = first;
      const spec = provider.spec;

      const now = await readNow(deps);
      const { db } = require("../../firebase");
      const shopId = access.shopId;
      // 🔒 แพ็กเกจ Payment Gateway (packageGate.js) · ก่อนอ่านค่าเชื่อมต่อ/ยิงผู้ให้บริการ/เขียนใบ
      if (!(await PG.passesPackage({ db, access, now, res }))) return undefined;
      // 💰 ปัดสตางค์ครั้งเดียวที่ปากทาง (K18 · B-08) · ยอดบนใบ = ยอดที่ยิงผู้ให้บริการ = ยอดที่ด่านเทียบ
      const amount = toSatang(input.amount) / 100;

      // ④ สถานะร้าน: ผลตรวจกระเป๋าของร้านชนะทะเบียน (สองทิศ)
      const stSnap = await CS.statusRef(db, shopId).get();
      const statusDoc = stSnap.exists ? stSnap.data() : null;
      const row = registry.shopChannelStatusOf({ stored: statusDoc, providerId: spec.id, channelId });
      const verdict = registry.resolveSalesChannel(channelId, row);
      if (!verdict.ok) return fail(res, 400, "unknown_channel", "ไม่รู้จักช่องทางนี้ หรือช่องทางนี้ยังไม่เปิดใช้งาน");

      const loaded = await loadConfig({ db, deps, shopId, spec, statusDoc });
      if (!loaded.ok) return sendFailOf(res, loaded);
      config = loaded.config;

      // เจ้า at-bill: สวิตช์ที่ร้านติ๊กเองคืออำนาจจริง (fail-closed · ไม่มีแถว = ปิด) · วางก่อนกันกดซ้ำ (ปิดแล้วไม่คืนแม้ใบเดิม)
      if (registry.channelChoiceOf(spec) === "at-bill" && !(row && row.enabled === true)) {
        return fail(res, 409, "channel_not_enabled_for_shop", "ร้านยังไม่ได้เปิดช่องทางนี้ในหน้าตั้งค่าการรับเงิน");
      }

      // ⑤ กันกดซ้ำ
      const clientRequestId = typeof input.clientRequestId === "string" && input.clientRequestId.trim() ? input.clientRequestId.trim() : null;
      if (clientRequestId) {
        const same = await findSameRequest({ db, shopId, clientRequestId, channelId, amount, nowMs: now.getTime() });
        if (same.paid) {
          return fail(res, 409, "already_paid", "รายการนี้ชำระเงินแล้ว ตรวจสถานะก่อนออกรหัสชำระเงินใหม่", {
            referenceId: same.paid.referenceId, channelId: same.paid.doc.channelId || null,
          });
        }
        if (same.waiting) {
          const v = await verifyReusable({ deps, provider, channel, config, shopId, doc: same.waiting.doc });
          if (v === "reuse") {
            const d = same.waiting.doc;
            // ใบที่ร้านเคยปิดจอ (cancelRequestedAt) แล้วกลับมาเปิดคำขอเดิม = จอเฝ้าใบนี้อีกครั้ง ⇒ ล้างป้ายปิดจอ
            //   ไม่งั้นเงินที่เข้าทีหลังถูกนับเป็น paidAfterCancel ทั้งที่จอยังรออยู่ (แอปไม่สร้างบิล)
            if (d.cancelRequestedAt) {
              await db.collection(COLLECTION).doc(same.waiting.referenceId).update({ cancelRequestedAt: null, reopenedAt: now, ...adminTrail(access) });
            }
            return ok(res, {
              referenceId: same.waiting.referenceId, channelId, providerId: spec.id,
              qrPayload: d.qrPayload, qrKind: d.qrKind || channel.qrKind || null, reused: true, ...adminFlag(access),
            });
          }
          if (v === "already_paid") {
            return fail(res, 409, "already_paid", "รายการนี้ชำระเงินแล้ว ตรวจสถานะก่อนออกรหัสชำระเงินใหม่", {
              referenceId: same.waiting.referenceId, channelId: same.waiting.doc.channelId || null,
            });
          }
        }
      }

      // ⑥ เขียนใบก่อนยิงผู้ให้บริการ (ห้ามสลับ · เน็ตหลุดหลังยิง = ยังมีใบให้ webhook ค้นย้อน)
      const referenceId = newReferenceIdOf(deps);
      const ref = db.collection(COLLECTION).doc(referenceId);
      await ref.set({
        referenceId, shopId, channelId, providerId: spec.id, amount, timestamp: now, process: "request",
        clientRequestId, createdBy: access.uid, providerRef: null, chargeId: null, qrPayload: null, qrKind: null,
        ...adminTrail(access),
      });

      const createQR = providerFn(deps, provider, "createQR");
      if (!createQR) return fail(res, 400, "channel_not_server_runtime", "ช่องทางนี้ขอรหัสผ่านเซิร์ฟเวอร์ไม่ได้");
      let result;
      try {
        result = await createQR({
          channel, config, amount, referenceId, shopId,
          channelOpen: row && typeof row.open === "boolean" ? row.open : undefined,
        });
      } catch (e) {
        console.error("pos gateway requestQr provider_threw", spec.id, referenceId, redact(e && e.message, config));
        return fail(res, 502, "provider_error", "ขอรหัสชำระเงินไม่สำเร็จ ลองใหม่อีกครั้ง");
      }
      if (!result || result.ok !== true || !result.data) {
        const e = (result && result.error) || {};
        console.error("pos gateway requestQr provider_failed", spec.id, referenceId, firstStr(e.code) || "unknown");
        return fail(res, 502, "provider_error", redact(e.message, config) || "ขอรหัสชำระเงินไม่สำเร็จ", { code: firstStr(e.code) || "unknown" });
      }
      const d = result.data;
      const qrKind = firstStr(d.qrKind) || channel.qrKind || null;
      await ref.update({
        providerRef: firstStr(d.providerRef), chargeId: firstStr(d.chargeId), qrPayload: firstStr(d.qrPayload), qrKind,
      });
      const outBody = { referenceId, channelId, providerId: spec.id, qrPayload: firstStr(d.qrPayload), qrKind, reused: false, ...adminFlag(access) };
      if (Number.isFinite(d.expiresInSec) && d.expiresInSec > 0) outBody.expiresInSec = d.expiresInSec;
      return ok(res, outBody);
    } catch (e) {
      return internalError(res, { name: e && e.name, message: redact(e && e.message, config) });
    }
  };
}

module.exports = {
  requestQr,
  REUSE_WINDOW_MS,
  _internal: { registryOf, envOf, providerFn, redact, loadConfig, toMillis, findSameRequest, verifyReusable, newReferenceIdOf, sameSatang },
};
