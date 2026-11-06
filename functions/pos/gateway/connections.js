// pos/gateway/connections.js — จอตั้งค่าการเชื่อมต่อรับเงิน 3 เส้น (ก้อน 7 · DEV-0001 · ยกท่าจากบ้านพี่น้อง)
//
// สัญญา: shopchamp-center/api/payment.connectionsGet.yaml · payment.testAndSave.yaml · payment.channelsCheck.yaml
// route (function pos_gateway): POST /pos_gateway/payment/connections-get · /payment/test-and-save · /payment/channels-check
// รูป: factory (deps) => handler(req, res) · deps: now credKey env registry + ตัวแทนผู้ให้บริการ testConnection checkChannels
//   deps.X มี = เรียก deps.X(args) แทนฟังก์ชันของเจ้า (args ก้อนเดียวกัน) · harness ใช้แทนการยิงผู้ให้บริการจริง
//   deps.registry = ทะเบียนแทน providers/index.js (เทสหน่วยใช้ · ไม่ส่ง = ทะเบียนจริง)
//
// กฎเหล็ก (ยกจากพี่น้อง + decision ก้อน 7):
//   ① คำตอบไม่มีค่าการเชื่อมต่อสักช่อง แม้ช่องที่ไม่ลับ (จอเริ่มว่างทุกครั้ง · บอกแค่ช่องไหนกรอกแล้ว `set`)
//      ทะเบียนที่ส่งให้จอคัดทีละช่อง (ไม่ spread spec) · ข้อความ error ของผู้ให้บริการผ่าน redact() ก่อนเสมอ
//   ② ทดสอบก่อน ผ่านค่อยเขียน · ทดสอบล้ม = ไม่เขียนฐานสักช่อง
//   ③ ช่องที่ไม่ส่งมา = คงค่าเดิม · ส่ง "" = ล้างช่องนั้น (credStore.mergeFields)
//   ④ ค่าที่เป็นของร้านได้ทีละร้าน (spec.connection.ownership · วันนี้ beam-bolt › boltConnectionId › beamBoltConnections)
//      ต้องผ่านทะเบียนเจ้าของก่อนแตะเจ้าและก่อนเขียน · ไม่มีแถว = จองให้ร้านนี้ใน transaction เดียวกับการเขียนค่า
//   ⑤ ระดับการยืนยัน 3 ขั้น: null (ยังไม่เคยกดทดสอบ) · 'partial' (บันทึกแล้วแต่ยืนยันไม่ครบช่อง หรือเซิร์ฟเวอร์ทดสอบแทนไม่ได้) · 'full'
// ที่เก็บ (credStore.js): ค่า = gatewayCreds/{shopId}[providerId] (ช่องลับเป็นกล่อง secretBox) · สถานะ = shop/{shopId}/meta/paymentGateway[providerId]._status
//   เครื่อง EDC (runtime device · ntt-edc) อยู่รายจุดคิดเงินที่ gatewayStations/{shopId} (เขียนผ่าน payment.stationEdcSet ไม่ใช่เส้นนี้)
// แอปเก่า: ไม่เห็นอะไรเปลี่ยน (collection ใหม่ทั้งหมด · ไม่แตะ 6 ก้อนเดิมใน meta/paymentGateway)
"use strict";

const {
  PaymentConnectionsGetRequest,
  PaymentTestAndSaveRequest,
  PaymentChannelsCheckRequest,
} = require("@shopchamp/schema");
const { ok, fail, deny, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow, depOr } = require("../_shared/deps");
const { callerAccess, isOwner, adminTrail, adminFlag } = require("../_shared/auth");
const SB = require("./secretBox");
const CS = require("./credStore");

const STATUS_KEY = CS.STATUS_KEY;
const PROVIDER_FN_NAMES = Object.freeze(["testConnection", "checkChannels", "pair", "unpair", "inquiry"]);

const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const fieldsOf = (spec) => (spec && spec.connection && Array.isArray(spec.connection.fields) ? spec.connection.fields : []);
const requiredKeysOf = (spec) => fieldsOf(spec).filter((f) => f.required).map((f) => f.key);
const SNAKE = /^[a-z0-9_]+$/;

/** ทะเบียนเจ้า: deps.registry (เทส) หรือตัวจริง (โหลดตอนเรียกครั้งแรก) */
function registryOf(deps) {
  const r = deps && deps.registry;
  if (r !== undefined && r !== null) {
    if (typeof r !== "object") throw new TypeError("deps.registry ต้องเป็น object");
    return r;
  }
  return require("./providers");
}

/**
 * providerFn(deps, mod, name) → ฟังก์ชันที่ใช้เรียกผู้ให้บริการ · deps.<name> มี = ใช้แทน · ไม่มี = ของเจ้า (ผูก this)
 *   คืน null เมื่อเจ้าไม่มีฟังก์ชันนั้นและไม่มีตัวแทน
 */
function providerFn(deps, mod, name) {
  const own = mod && typeof mod[name] === "function" ? mod[name].bind(mod) : null;
  return depOr(deps, name, own);
}

/**
 * ช่องเสริมที่ส่งให้ผู้ให้บริการทุกครั้ง: credKey (เจ้าที่ถอดกุญแจรายร้านเอง · beam-bolt) · env (เจ้าที่อ่าน URL/กุญแจกลางจาก env · kbank-qr)
 *   ไม่มีใน deps = ไม่ใส่ (เจ้าอ่าน process.env เอง)
 */
function extrasOf(deps) {
  const out = {};
  if (deps && typeof deps.credKey === "string" && deps.credKey) out.credKey = deps.credKey;
  if (deps && deps.env && typeof deps.env === "object") out.env = deps.env;
  return out;
}

/** ค่าเวลา (Date · Timestamp · ISO) → ISO หรือ null */
function isoOf(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v || null;
  let d = null;
  if (v instanceof Date) d = v;
  else if (typeof v.toDate === "function") d = v.toDate();
  else if (typeof v.toMillis === "function") d = new Date(v.toMillis());
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** ปิดบังค่าการเชื่อมต่อที่อาจติดมากับข้อความของผู้ให้บริการ (ค่ายาว ≥ 4 ตัว) — ชั้นสุดท้าย ไม่ใช่ชั้นเดียว */
function redact(text, values) {
  let out = typeof text === "string" ? text : "";
  for (const v of Object.values(asObj(values))) {
    const s = typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
    if (s.length >= 4 && out.includes(s)) out = out.split(s).join("«ปกปิด»");
  }
  return out.slice(0, 300);
}

/** รหัสของผู้ให้บริการ → รหัสตัวเล็กที่ส่งให้จอได้ (ไม่ผ่านรูป = null) */
const providerCodeOf = (e) => (e && typeof e.code === "string" && SNAKE.test(e.code) && e.code.length <= 64 ? e.code : null);

/** กุญแจเข้ารหัส: deps.credKey → env (deps.env ชนะ process.env) · ไม่มี = null (ผู้เรียกตัดสินว่าต้องใช้ไหม) */
function credKeyOf(deps) {
  const r = SB.readKey({ deps, env: deps && deps.env && typeof deps.env === "object" ? deps.env : undefined });
  return r.key ? { key: r.key } : { key: null, error: r.error };
}

/** รหัสจาก credStore/secretBox → status · กุญแจระบบไม่มี/ผิดรูป = 500 · ถอดกล่องเดิมไม่ได้ = 409 (ร้านกรอกค่าลับใหม่ได้) */
function credFailure(res, r) {
  if (r.code === "gateway_cred_unreadable") return fail(res, 409, r.code, "อ่านค่าลับเดิมของร้านไม่ได้ — กรอกค่าลับทุกช่องใหม่แล้วบันทึก");
  if (r.code === "gateway_cred_key_missing" || r.code === "gateway_cred_key_invalid") return fail(res, 500, r.code, "ระบบยังไม่พร้อมเก็บค่าลับ — ติดต่อทีมงาน Shopchamp");
  return fail(res, 400, SNAKE.test(r.code || "") ? r.code : "bad_input", r.message, r.keys ? { keys: r.keys } : undefined);
}

/** doc id ที่ Firestore รับ (ใช้กับค่าที่จะเป็น doc id ของทะเบียนเจ้าของ) */
function isSafeDocId(v) {
  if (typeof v !== "string" || !v || v.trim() !== v) return false;
  if (v.includes("/") || v === "." || v === ".." || /^__.*__$/.test(v)) return false;
  return Buffer.byteLength(v, "utf8") <= 1500;
}

const OWNED_BY_OTHER = Object.freeze({
  code: "connection_owned_by_other_shop",
  message: "รหัสเครื่องนี้ถูกจับคู่กับร้านอื่นอยู่ — ใช้ปุ่มจับคู่เครื่องด้วยรหัสจากจอเครื่องของร้านคุณ",
});

/** โยนใน transaction เพื่อยกเลิกโดยไม่เขียนสักช่อง แล้วผู้เรียกแปลงเป็น 409 */
class AbortTx extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** ระดับการยืนยัน (กฎ ⑤) · ทดสอบแทนไม่ได้ = partial เสมอ */
function deriveVerifiedLevel({ requiredKeys, verifiedFields, tested }) {
  if (!tested) return "partial";
  const got = new Set(Array.isArray(verifiedFields) ? verifiedFields : []);
  return requiredKeys.every((k) => got.has(k)) ? "full" : "partial";
}

/** ทะเบียนเจ้าของ 1 แถว */
const ownerRef = (db, ownership, value) => db.collection(ownership.registry).doc(String(value));

/** อ่านแถวทะเบียนเจ้าของ → {exists, shopId} */
async function readOwner(getter, db, ownership, value) {
  const snap = await getter(ownerRef(db, ownership, value));
  if (!snap || !snap.exists) return { exists: false, shopId: null };
  const d = asObj(snap.data());
  return { exists: true, shopId: typeof d.shopId === "string" ? d.shopId : null };
}

/** ทะเบียนที่ส่งให้จอ — คัดทีละช่อง · รับ module ของเจ้า (canX derive จากฟังก์ชันจริง) */
function projectProviderSpec(reg, mod) {
  if (!mod || !mod.spec) throw new Error("gateway/connections: projectProviderSpec ต้องรับ module ของเจ้า (ที่มี .spec)");
  const spec = mod.spec;
  const test = asObj(spec.connection && spec.connection.test);
  return {
    id: spec.id,
    labelKey: spec.labelKey,
    labelFallback: spec.labelFallback,
    runtime: spec.runtime,
    channelChoice: reg.channelChoiceOf(spec),
    canCheckChannels: reg.canCheckChannelsOf(mod),
    canPair: reg.canPairOf(mod),
    canCancel: typeof reg.canCancelOf === "function" ? reg.canCancelOf(mod) : false,
    connection: {
      fields: fieldsOf(spec).map((f) => ({
        key: f.key,
        labelKey: f.labelKey,
        labelFallback: f.labelFallback,
        required: !!f.required,
        secret: f.secret === true,
      })),
      test: { kind: test.kind, note: test.note },
    },
    // แถวที่เจ้าประกาศ sellable:false ไม่ออกถึงจอ · runtime device ได้ tradeType/serviceTypes (จอประกอบคำสั่งยิงเครื่องเอง)
    channels: (Array.isArray(spec.channels) ? spec.channels : []).filter((c) => !reg.isHiddenChannel(c)).map((c) => ({
      channelId: c.channelId,
      nameKey: c.nameKey,
      nameFallback: c.nameFallback,
      lastKnownAvailable: !!c.lastKnownAvailable,
      ...(spec.runtime === "device"
        ? {
            tradeType: typeof c.tradeType === "string" ? c.tradeType : null,
            serviceTypes: Array.isArray(c.serviceTypes) ? c.serviceTypes.map(String) : null,
          }
        : {}),
    })),
  };
}

/** เครื่อง EDC ของจุดคิดเงิน → {ip, port, name} หรือ null · port ไม่ตั้ง = default ของ spec */
function deviceConfigOf(spec, stationsDoc, stationId) {
  if (!stationId) return null;
  const st = asObj(asObj(asObj(stationsDoc).stations)[stationId]);
  if (st.providerId !== undefined && st.providerId !== spec.id) return null;
  const dev = asObj(st.device);
  if (typeof dev.ip !== "string" || !dev.ip) return null;
  const portField = fieldsOf(spec).find((f) => f.key === "port");
  const portDefault = portField && Number.isInteger(portField.default) ? portField.default : null;
  return {
    ip: dev.ip,
    port: Number.isInteger(dev.port) ? dev.port : portDefault,
    name: typeof dev.name === "string" ? dev.name : null,
  };
}

/** สถานะของร้านต่อ 1 เจ้า — ออกครบทุกเจ้าแม้ยังไม่เคยตั้ง · ไม่มีค่าใด ๆ */
function projectShopConnection(reg, spec, { block, statusDoc, stationsDoc, stationId }) {
  const st = asObj(CS.statusOf(statusDoc, spec.id));
  const savedChannels = asObj(st.channels);
  const channels = {};
  for (const c of Array.isArray(spec.channels) ? spec.channels : []) {
    const row = asObj(savedChannels[c.channelId]);
    channels[c.channelId] = {
      enabled: row.enabled === true,
      open: typeof row.open === "boolean" ? row.open : null, // null = ยังไม่เคยถามสำเร็จ ไม่ใช่ "ปิด"
      checkedAt: isoOf(row.checkedAt),
    };
  }
  const declared = new Set(fieldsOf(spec).map((f) => f.key));
  const device = spec.runtime === "device";
  const deviceConfig = device ? deviceConfigOf(spec, stationsDoc, stationId) : undefined;
  // ช่องของเจ้า device มาจากเครื่องของจุดคิดเงิน (ไม่ใช่ gatewayCreds)
  const fields = device
    ? fieldsOf(spec).map((f) => ({
        key: f.key, secret: f.secret === true, required: !!f.required,
        set: !!deviceConfig && f.key === "ip" ? true : !!deviceConfig && f.key === "port" ? deviceConfig.port !== null : false,
      }))
    : CS.fieldStateOf({ spec, block });
  const missing = fields.filter((f) => f.required && !f.set).map((f) => f.key);
  const hasBlock = device ? !!deviceConfig : Object.keys(asObj(block)).length > 0;
  const out = {
    providerId: spec.id,
    configured: hasBlock && missing.length === 0,
    missing,
    fields,
    verifiedAt: isoOf(st.verifiedAt),
    verifiedLevel: typeof st.verifiedLevel === "string" ? st.verifiedLevel : null,
    verifiedNote: typeof st.verifiedNote === "string" ? st.verifiedNote : null,
    verifiedFields: Array.isArray(st.verifiedFields) ? st.verifiedFields.filter((k) => typeof k === "string" && declared.has(k)) : null,
    channels,
  };
  if (device) out.deviceConfig = deviceConfig;
  if (reg.ownershipOf(spec)) out.pairedDevice = pairedDeviceOf(st);
  return out;
}

/** `_status.pairedDevice` ให้จอ — ไม่มีรหัสเต็มโดยโครงสร้าง (4 ตัวท้ายเท่านั้น) */
function pairedDeviceOf(status) {
  const p = asObj(status && status.pairedDevice);
  if (!Object.keys(p).length) return null;
  return {
    deviceId: typeof p.deviceId === "string" ? p.deviceId : null,
    pairedAt: isoOf(p.pairedAt),
    boltConnectionIdTail: typeof p.boltConnectionIdTail === "string" ? p.boltConnectionIdTail : null,
  };
}

/** เจ้าที่ขอมา → {mod, spec} | deny 400 unknown_provider · ช่องชื่อ `_status` = โยน (ชื่อจองไว้) */
function resolveProvider(reg, providerId) {
  const mod = reg.getProvider(providerId);
  if (!mod || !mod.spec) return deny(400, "unknown_provider", `ไม่รู้จักผู้ให้บริการ ${providerId}`);
  if (fieldsOf(mod.spec).some((f) => f.key === STATUS_KEY)) throw new Error(`gateway/connections: เจ้า ${mod.spec.id} ประกาศช่องชื่อ ${STATUS_KEY}`);
  return { ok: true, mod, spec: mod.spec };
}

/** ค่าที่ provider ใช้ของร้าน (ถอดกล่องแล้ว) — ใช้ร่วม channelsCheck · pairing · webhook */
async function loadConfig({ db, deps, spec, shopId }) {
  const snap = await CS.credsRef(db, shopId).get();
  const block = snap.exists ? asObj(snap.data())[spec.id] : undefined;
  const needKey = fieldsOf(spec).some((f) => f.secret === true && CS.isFilled(asObj(block)[f.key]));
  const k = needKey ? credKeyOf(deps) : { key: null };
  if (needKey && !k.key) return { ok: false, code: k.error.code, message: k.error.message };
  const opened = CS.openConfig({ spec, shopId, block, key: k.key });
  if (!opened.ok) return opened;
  const missing = requiredKeysOf(spec).filter((key) => opened.values[key] === undefined);
  return { ok: true, block: asObj(block), values: opened.values, missing };
}

// ── ① connectionsGet — ทุกคนในร้าน ────────────────────────────────────────────
function connectionsGet(deps) {
  return async function handler(req, res) {
    const body = asObj(req && req.body);
    const gate = callerAccess(req, body.shopId);
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;
    const input = parseOr400(PaymentConnectionsGetRequest, body, res);
    if (!input) return undefined;
    try {
      const reg = registryOf(deps);
      const { db } = require("../../firebase");
      const mods = reg.listProviderModules();
      const reads = [CS.credsRef(db, access.shopId).get(), CS.statusRef(db, access.shopId).get()];
      if (input.stationId) reads.push(CS.stationsRef(db, access.shopId).get());
      const [credsSnap, statusSnap, stationsSnap] = await Promise.all(reads);
      const creds = credsSnap.exists ? asObj(credsSnap.data()) : {};
      const statusDoc = statusSnap.exists ? asObj(statusSnap.data()) : {};
      const stationsDoc = stationsSnap && stationsSnap.exists ? asObj(stationsSnap.data()) : {};
      return ok(res, {
        providers: mods.map((m) => projectProviderSpec(reg, m)),
        connections: mods.map((m) =>
          projectShopConnection(reg, m.spec, { block: creds[m.spec.id], statusDoc, stationsDoc, stationId: input.stationId })),
        ...(input.stationId ? { stationId: input.stationId } : {}),
        ...adminFlag(access),
      });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

// ── ② testAndSave — เจ้าของเท่านั้น · ทดสอบก่อน ผ่านค่อยเขียน ───────────────────
function testAndSave(deps) {
  return async function handler(req, res) {
    const body = asObj(req && req.body);
    const gate = callerAccess(req, body.shopId);
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;
    if (!isOwner(access)) return sendDeny(res, deny(403, "owner_required"));
    const input = parseOr400(PaymentTestAndSaveRequest, body, res);
    if (!input) return undefined;
    let redactWith = {};
    try {
      const reg = registryOf(deps);
      const r = resolveProvider(reg, input.providerId);
      if (!r.ok) return sendDeny(res, r);
      const { mod, spec } = r;
      const shopId = access.shopId;
      const wanted = asObj(input.channels);
      const known = new Set((spec.channels || []).map((c) => c.channelId));
      const stray = Object.keys(wanted).filter((id) => !known.has(id));
      if (stray.length) return fail(res, 400, "unknown_channel", `ช่องทางเหล่านี้ไม่ใช่ของ ${spec.id}: ${stray.join(", ")}`, { channels: stray });
      const incoming = asObj(input.fields);
      const device = spec.runtime === "device";
      // เครื่อง EDC ผูกรายจุดคิดเงิน (payment.stationEdcSet) · เส้นนี้ของเจ้า device เก็บแค่สวิตช์ช่องทาง
      if (device && Object.keys(incoming).length) {
        return fail(res, 400, "device_fields_per_station", "ที่อยู่เครื่อง EDC ตั้งรายจุดคิดเงิน (เมนูจุดคิดเงิน) ไม่ใช่ที่นี่");
      }

      const { db } = require("../../firebase");
      const now = await readNow(deps);
      const credsSnap = await CS.credsRef(db, shopId).get();
      const oldBlock = credsSnap.exists ? asObj(credsSnap.data())[spec.id] : undefined;

      let merged = { ok: true, block: undefined, values: {} };
      if (!device) {
        const needKey = fieldsOf(spec).some((f) => f.secret === true);
        const k = needKey ? credKeyOf(deps) : { key: null };
        merged = CS.mergeFields({ spec, shopId, block: oldBlock, incoming, key: k.key });
        if (!merged.ok) return credFailure(res, merged);
        const missing = requiredKeysOf(spec).filter((key) => merged.values[key] === undefined);
        if (missing.length) return fail(res, 400, "missing_fields", `ยังกรอกไม่ครบ — ขาด: ${missing.join(", ")}`, { missing });
      }
      redactWith = merged.values;

      // ④ ทะเบียนเจ้าของ — ก่อนแตะเจ้า ก่อนเขียน
      const ownership = reg.ownershipOf(spec);
      let claim = null;
      if (ownership && merged.values[ownership.field] !== undefined) {
        const value = merged.values[ownership.field];
        if (!isSafeDocId(value)) return fail(res, 400, "bad_input", `ค่าของช่อง ${ownership.field} มีอักขระที่ใช้ไม่ได้`);
        const owner = await readOwner((ref) => ref.get(), db, ownership, value);
        if (owner.exists && owner.shopId !== shopId) return fail(res, 409, OWNED_BY_OTHER.code, OWNED_BY_OTHER.message);
        claim = { ownership, value };
      }

      // ② ทดสอบ (ยังไม่เขียนอะไร)
      const test = asObj(spec.connection && spec.connection.test);
      const testFn = providerFn(deps, mod, "testConnection");
      const canTest = (test.kind === "auth" || test.kind === "query-nonexistent") && !!testFn;
      let verifiedFields = [];
      let verifiedNote = "";
      if (canTest) {
        let result;
        try {
          result = await testFn({ config: merged.values, shopId, ...extrasOf(deps) });
        } catch (e) {
          try { console.error("gateway testAndSave provider_threw", spec.id, redact(e && e.message, redactWith)); } catch (_) { /* ไม่ล้มคำตอบ */ }
          return fail(res, 502, "provider_error", "ทดสอบการเชื่อมต่อไม่สำเร็จ ลองใหม่อีกครั้ง");
        }
        if (!result || result.ok !== true || !result.data) {
          const e = asObj(result && result.error);
          return fail(res, 422, "test_failed", redact(e.message, redactWith) || "ทดสอบการเชื่อมต่อไม่ผ่าน", { providerCode: providerCodeOf(e) || undefined });
        }
        const declared = new Set(fieldsOf(spec).map((f) => f.key));
        verifiedFields = (Array.isArray(result.data.verifiedFields) ? result.data.verifiedFields : []).filter((k) => declared.has(k));
        verifiedNote = typeof result.data.note === "string" ? redact(result.data.note, redactWith) : "";
      } else {
        verifiedNote = `เซิร์ฟเวอร์ทดสอบให้ไม่ได้ (วิธีทดสอบของเจ้านี้ = ${test.kind}) — ยังไม่ได้ยืนยันค่าที่กรอก`;
      }
      const verifiedLevel = deriveVerifiedLevel({ requiredKeys: requiredKeysOf(spec), verifiedFields, tested: canTest });
      const trail = adminTrail(access);

      // ผ่านแล้วค่อยเขียน — ค่า + สถานะ + ทะเบียนเจ้าของ ใน transaction เดียว (อ่านครบก่อนเขียน)
      try {
        await db.runTransaction(async (tx) => {
          const cRef = CS.credsRef(db, shopId);
          const sRef = CS.statusRef(db, shopId);
          const cSnap = await tx.get(cRef);
          const sSnap = await tx.get(sRef);
          let regRef = null;
          let regExists = false;
          if (claim) {
            regRef = ownerRef(db, claim.ownership, claim.value);
            const regSnap = await tx.get(regRef);
            if (regSnap && regSnap.exists) {
              regExists = true;
              if (asObj(regSnap.data()).shopId !== shopId) throw new AbortTx(OWNED_BY_OTHER.code, OWNED_BY_OTHER.message);
            }
          }
          const statusDoc = sSnap.exists ? asObj(sSnap.data()) : {};
          const prevBlock = asObj(statusDoc[spec.id]);
          const prevStatus = asObj(prevBlock[STATUS_KEY]);
          const prevChannels = asObj(prevStatus.channels);
          const channels = {};
          for (const c of spec.channels || []) {
            const prev = asObj(prevChannels[c.channelId]);
            channels[c.channelId] = {
              enabled: Object.prototype.hasOwnProperty.call(wanted, c.channelId) ? wanted[c.channelId] : prev.enabled === true,
              open: typeof prev.open === "boolean" ? prev.open : null,
              checkedAt: prev.checkedAt === undefined ? null : prev.checkedAt,
            };
          }
          // pairedDevice อยู่ต่อเมื่อค่าในช่อง ownership ยังเป็นค่าเดิม
          const held = claim ? asObj(asObj(cSnap.exists ? cSnap.data() : {})[spec.id])[claim.ownership.field] : undefined;
          const keepPaired = !!claim && typeof held === "string" && held === claim.value && prevStatus.pairedDevice;
          const nextStatus = { verifiedAt: now, verifiedLevel, verifiedNote, verifiedFields, channels, ...(keepPaired ? { pairedDevice: prevStatus.pairedDevice } : {}) };
          const statusPatch = { [spec.id]: { ...prevBlock, [STATUS_KEY]: nextStatus } };
          if (sSnap.exists) tx.update(sRef, statusPatch);
          else tx.set(sRef, statusPatch);
          if (!device) {
            // update แทนที่ก้อนของเจ้านี้ทั้งก้อน (ช่องที่ล้าง "" หายจริง · เจ้าอื่นไม่ขยับ)
            const credsPatch = { [spec.id]: merged.block, updatedAt: now, updatedBy: access.uid, ...trail };
            if (cSnap.exists) tx.update(cRef, credsPatch);
            else tx.set(cRef, credsPatch);
          }
          if (claim && !regExists) {
            tx.set(regRef, { shopId, providerId: spec.id, pairedAt: now, claimedVia: "test-and-save", ...trail });
          }
        });
      } catch (e) {
        if (e instanceof AbortTx) return fail(res, 409, e.code, e.message);
        throw e;
      }
      return ok(res, { providerId: spec.id, saved: true, verifiedLevel, verifiedFields, verifiedNote, ...adminFlag(access) });
    } catch (e) {
      try { console.error("gateway testAndSave error", redact(e && e.message, redactWith)); } catch (_) { /* ไม่ล้มคำตอบ */ }
      return fail(res, 500, "internal_error");
    }
  };
}

// ── ③ channelsCheck — เจ้าของเท่านั้น · ถามผู้ให้บริการว่ากระเป๋าไหนเปิด แล้วเก็บผล ──
function channelsCheck(deps) {
  return async function handler(req, res) {
    const body = asObj(req && req.body);
    const gate = callerAccess(req, body.shopId);
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;
    if (!isOwner(access)) return sendDeny(res, deny(403, "owner_required"));
    const input = parseOr400(PaymentChannelsCheckRequest, body, res);
    if (!input) return undefined;
    let redactWith = {};
    try {
      const reg = registryOf(deps);
      const r = resolveProvider(reg, input.providerId);
      if (!r.ok) return sendDeny(res, r);
      const { mod, spec } = r;
      // เกณฑ์เดียวกับที่จอเห็น (canCheckChannels) — derive จากฟังก์ชันจริงของเจ้า
      if (!reg.canCheckChannelsOf(mod)) return fail(res, 400, "check_not_supported", `${spec.id} ไม่มีวิธีตรวจกระเป๋าจากเซิร์ฟเวอร์`);
      const { db } = require("../../firebase");
      const now = await readNow(deps);
      const shopId = access.shopId;
      const cfg = await loadConfig({ db, deps, spec, shopId });
      if (!cfg.ok) return credFailure(res, cfg);
      if (cfg.missing.length) return fail(res, 409, "gateway_not_configured", `ยังตั้งค่าไม่ครบ — ขาด: ${cfg.missing.join(", ")}`, { missing: cfg.missing });
      redactWith = cfg.values;

      const checkFn = providerFn(deps, mod, "checkChannels");
      let result;
      try {
        result = await checkFn({ config: cfg.values, channels: spec.channels, shopId, ...extrasOf(deps) });
      } catch (e) {
        try { console.error("gateway channelsCheck provider_threw", spec.id, redact(e && e.message, redactWith)); } catch (_) { /* ไม่ล้มคำตอบ */ }
        return fail(res, 502, "provider_error", "ตรวจสถานะกระเป๋าไม่สำเร็จ ลองใหม่อีกครั้ง");
      }
      if (!result || result.ok !== true || !result.data) {
        const e = asObj(result && result.error);
        return fail(res, 422, "check_failed", redact(e.message, redactWith) || "ตรวจสถานะกระเป๋าไม่สำเร็จ", { providerCode: providerCodeOf(e) || undefined });
      }
      const rows = Array.isArray(result.data.results) ? result.data.results : [];
      const known = new Set((spec.channels || []).map((c) => c.channelId));
      const usable = rows.filter((row) => row && known.has(row.channelId));
      // open:null = ถามไม่สำเร็จ ⇒ ไม่จำลงฐาน (ไม่ใช่ "ปิด")
      const persist = usable.filter((row) => typeof row.open === "boolean");
      const checkedAtOf = (row) => (typeof row.checkedAt === "string" && row.checkedAt ? row.checkedAt : now);
      if (persist.length) {
        await db.runTransaction(async (tx) => {
          const sRef = CS.statusRef(db, shopId);
          const sSnap = await tx.get(sRef);
          const statusDoc = sSnap.exists ? asObj(sSnap.data()) : {};
          const prevBlock = asObj(statusDoc[spec.id]);
          const prevStatus = asObj(prevBlock[STATUS_KEY]);
          const channels = { ...asObj(prevStatus.channels) };
          for (const row of persist) {
            const prev = asObj(channels[row.channelId]);
            channels[row.channelId] = { enabled: prev.enabled === true, open: row.open, checkedAt: checkedAtOf(row) };
          }
          const patch = { [spec.id]: { ...prevBlock, [STATUS_KEY]: { ...prevStatus, channels } } };
          if (sSnap.exists) tx.update(sRef, patch);
          else tx.set(sRef, patch);
        });
      }
      const out = {
        providerId: spec.id,
        results: usable.map((row) => ({
          channelId: row.channelId,
          open: typeof row.open === "boolean" ? row.open : null,
          checkedAt: typeof row.open === "boolean" ? isoOf(checkedAtOf(row)) : null,
        })),
        ...adminFlag(access),
      };
      if (usable.some((row) => row.cached === true)) out.throttled = true;
      return ok(res, out);
    } catch (e) {
      try { console.error("gateway channelsCheck error", redact(e && e.message, redactWith)); } catch (_) { /* ไม่ล้มคำตอบ */ }
      return fail(res, 500, "internal_error");
    }
  };
}

module.exports = {
  connectionsGet,
  testAndSave,
  channelsCheck,
  _internal: {
    STATUS_KEY, PROVIDER_FN_NAMES, OWNED_BY_OTHER, AbortTx,
    asObj, fieldsOf, requiredKeysOf, isoOf, redact, providerCodeOf, credKeyOf, credFailure, isSafeDocId,
    registryOf, providerFn, extrasOf, resolveProvider, deriveVerifiedLevel, ownerRef, readOwner, loadConfig,
    projectProviderSpec, projectShopConnection, deviceConfigOf, pairedDeviceOf,
  },
};
