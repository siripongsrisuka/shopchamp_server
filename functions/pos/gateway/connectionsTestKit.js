// pos/gateway/connectionsTestKit — ของใช้ร่วมของเทส connections · pairing · webhooks · routes (ก้อน 7 · DEV-0001)
//   ไม่ใช่เทสเอง (ไม่ลงท้าย .test.js) · ❌ ไม่ require ในโค้ดจริง
//   ① ฐานปลอม: เก็บเอกสารตาม path เต็ม · บันทึกทุกการเขียน (LOG) · update ของ doc ที่ไม่มี = ปัด (แบบ Firestore)
//      ปัดการอ่านหลังเขียนใน transaction เดียว · set แทนทั้ง doc (ไม่มี merge)
//   ② ทะเบียนเจ้าปลอม: API ชื่อเดียวกับ providers/index.js · ฟังก์ชันของเจ้าตอบตามที่เทสตั้ง (P) และบันทึก args
//      ⇒ เทสหน่วยไม่ผูกกับทะเบียนจริง · ทะเบียนจริงพิสูจน์ที่สัญญา (harness)
//   ③ กุญแจทดสอบ (ไบต์ 0..31) · ของจริงอยู่ใน env ของ Functions เท่านั้น
"use strict";

const path = require("path");
const crypto = require("crypto");
const SB = require("./secretBox");

const TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
function clone(v) {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  const out = {};
  for (const k of Object.keys(v)) if (v[k] !== undefined) out[k] = clone(v[k]);
  return out;
}

function makeStore() {
  const st = { DATA: {}, LOG: [], READS: [] };
  const apply = (w) => {
    if (w.op === "set") st.DATA[w.path] = clone(w.v);
    else if (w.op === "update") {
      if (st.DATA[w.path] === undefined) throw new Error(`update ${w.path} ที่ไม่มีอยู่ (Firestore ปัด)`);
      st.DATA[w.path] = { ...st.DATA[w.path], ...clone(w.v) };
    } else if (w.op === "delete") delete st.DATA[w.path];
  };
  const snapOf = (p, id) => {
    st.READS.push(p);
    const d = st.DATA[p];
    return { exists: d !== undefined, id, data: () => clone(d) };
  };
  const docRef = (collPath, id) => {
    const p = `${collPath}/${id}`;
    return {
      id, path: p,
      get: async () => snapOf(p, id),
      set: async (v) => { const w = { op: "set", path: p, v }; apply(w); st.LOG.push(w); },
      update: async (v) => { const w = { op: "update", path: p, v }; apply(w); st.LOG.push(w); },
      delete: async () => { const w = { op: "delete", path: p }; apply(w); st.LOG.push(w); },
      collection: (sub) => coll(`${p}/${sub}`),
    };
  };
  const query = (collPath, filters, lim) => ({
    where: (f, op, v) => {
      if (op !== "==") throw new Error(`ฐานปลอมรองรับแค่ == · ได้ ${op}`);
      return query(collPath, [...filters, [f, v]], lim);
    },
    limit: (n) => query(collPath, filters, n),
    get: async () => {
      st.READS.push(`${collPath}?${filters.map(([f, v]) => `${f}==${v}`).join("&")}`);
      const prefix = `${collPath}/`;
      let docs = Object.keys(st.DATA)
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .filter((k) => filters.every(([f, v]) => st.DATA[k][f] === v))
        .map((k) => ({ exists: true, id: k.slice(prefix.length), data: () => clone(st.DATA[k]) }));
      if (lim != null) docs = docs.slice(0, lim);
      return { empty: !docs.length, docs };
    },
  });
  const coll = (collPath) => ({
    doc: (id) => docRef(collPath, id),
    where: (f, op, v) => query(collPath, [], null).where(f, op, v),
  });
  st.db = {
    collection: (c) => coll(c),
    runTransaction: async (fn) => {
      const writes = [];
      const tx = {
        get: async (r) => {
          if (writes.length) throw new Error(`อ่าน ${r.path} หลังเขียน (Firestore ปัด)`);
          return r.get();
        },
        set: (r, v) => { writes.push({ op: "set", path: r.path, v }); return tx; },
        update: (r, v) => { writes.push({ op: "update", path: r.path, v }); return tx; },
        delete: (r) => { writes.push({ op: "delete", path: r.path }); return tx; },
      };
      const out = await fn(tx);
      for (const w of writes) apply(w);
      st.LOG.push(...writes);
      return out;
    },
  };
  st.reset = (data) => { st.DATA = clone(data || {}); st.LOG = []; st.READS = []; };
  st.writesTo = (prefix) => st.LOG.filter((w) => w.path === prefix || w.path.startsWith(prefix + "/"));
  return st;
}

/** แทน functions/firebase ใน require.cache (เรียกก่อน require handler) */
function installFakeFirebase(store) {
  const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: store.db, admin: {} } };
}

/** กล่องกุญแจทดสอบ */
function sealTest(plain, binding) {
  const { key } = SB.readKey({ deps: { credKey: TEST_KEY } });
  return SB.seal(plain, binding, { key }).box;
}

/** ลายเซ็น Beam ของ rawBody ด้วยกุญแจ base64 */
function beamSign(rawBody, hmacKeyB64) {
  return crypto.createHmac("sha256", Buffer.from(hmacKeyB64, "base64")).update(rawBody).digest("base64");
}

/**
 * ทะเบียนเจ้าปลอม · P = { [fnName]: คำตอบ | ฟังก์ชัน(args) | Error } · calls[fnName] = args ทุกครั้ง
 */
function makeRegistry(P = {}) {
  const calls = {};
  const answer = (name) => async (args) => {
    (calls[name] = calls[name] || []).push(args);
    const a = P[name];
    if (a instanceof Error) throw a;
    return typeof a === "function" ? a(args) : a;
  };
  const mods = [
    {
      spec: {
        id: "ntt-h2h", runtime: "server", labelKey: "screens.paymentGateway.provider.ntt-h2h.name", labelFallback: "NTT",
        connection: {
          fields: [
            { key: "terminalId", labelKey: "f.tid", labelFallback: "TID", required: true },
            { key: "password", labelKey: "f.pw", labelFallback: "รหัสผ่าน", required: true, secret: true },
          ],
          test: { kind: "auth", note: "ขอ token" },
        },
        channels: [
          { channelId: "nttThaiQr", nameKey: "c.a", nameFallback: "QR", tranType: "T", qrKind: "text", lastKnownAvailable: true },
          { channelId: "nttShopeePay", nameKey: "c.b", nameFallback: "Shopee", tranType: "G", qrKind: "text", lastKnownAvailable: true },
        ],
      },
      testConnection: answer("testConnection"), checkChannels: answer("checkChannels"), inquiry: answer("inquiry"),
      parseNotify: (b) => {
        const v = b && b.out_trade_no;
        return v ? { ok: true, outTradeNo: String(v) } : { ok: false };
      },
    },
    {
      spec: {
        id: "kbank-qr", runtime: "server", labelKey: "p.kbank", labelFallback: "KBank",
        connection: { fields: [{ key: "merchantId", labelKey: "f.mid", labelFallback: "MID", required: true }], test: { kind: "query-nonexistent", note: "ถาม" } },
        channels: [{ channelId: "kbankThaiQr", nameKey: "c.k", nameFallback: "QR", qrKind: "text", lastKnownAvailable: true }],
      },
      testConnection: answer("testConnection"), inquiry: answer("inquiry"), cancelQR: answer("cancelQR"),
      parseCallback: (b) => (b && typeof b.reference1 === "string" && b.reference1 ? { ok: true, referenceId: b.reference1 } : { ok: false }),
    },
    {
      spec: {
        id: "beam-bolt", runtime: "server", channelChoice: "at-bill", labelKey: "p.beam", labelFallback: "Beam",
        connection: {
          fields: [{ key: "boltConnectionId", labelKey: "f.bc", labelFallback: "รหัสเชื่อมต่อ", required: true }],
          test: { kind: "query-nonexistent", note: "ถาม" },
          ownership: { field: "boltConnectionId", registry: "beamBoltConnections" },
        },
        channels: [
          { channelId: "beamBoltPromptPay", nameKey: "c.bp", nameFallback: "พร้อมเพย์", lastKnownAvailable: false },
          { channelId: "beamBoltCardInstallments", nameKey: "c.bi", nameFallback: "ผ่อน", lastKnownAvailable: false, sellable: false },
        ],
      },
      testConnection: answer("testConnection"), inquiry: answer("inquiry"), cancelQR: answer("cancelQR"), pair: answer("pair"), unpair: answer("unpair"),
      verifyBeamSignature: ({ rawBody, signatureHeader, hmacKey }) => {
        if (!rawBody || !signatureHeader || !hmacKey) return false;
        const a = Buffer.from(beamSign(rawBody, hmacKey));
        const b = Buffer.from(String(signatureHeader));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      },
      pickMerchantId: (b) => (b && b.merchant && typeof b.merchant.merchantId === "string" ? b.merchant.merchantId : b && typeof b.merchantId === "string" ? b.merchantId : ""),
      parseBeamEvent: (b, ev) => {
        const t = String(ev || "").toLowerCase();
        if (!t) return { ok: false, error: "no_event_type" };
        if (!["bolt_intent.paid", "bolt_intent.canceled", "bolt_intent.expired", "charge.failed"].includes(t)) return { ok: false, error: "unknown_event" };
        const ref = t === "charge.failed" ? b.sourceId : b.id;
        return ref ? { ok: true, providerRef: ref, eventType: t, paid: t === "bolt_intent.paid" } : { ok: false, error: "no_intent_id" };
      },
    },
    {
      spec: {
        id: "ntt-edc", runtime: "device", channelChoice: "at-bill", labelKey: "p.edc", labelFallback: "EDC",
        connection: {
          fields: [{ key: "ip", labelKey: "f.ip", labelFallback: "IP", required: true }, { key: "port", labelKey: "f.port", labelFallback: "พอร์ต", required: false, default: 8020 }],
          test: { kind: "device-ping", note: "แอปเคาะเอง" },
        },
        channels: [{ channelId: "nttEdcCard", nameKey: "c.e", nameFallback: "บัตร", tradeType: "CARD", serviceTypes: [], lastKnownAvailable: false }],
      },
    },
  ];
  const byId = new Map(mods.map((m) => [m.spec.id, m]));
  const index = new Map();
  for (const m of mods) for (const ch of m.spec.channels) index.set(ch.channelId, { provider: m, channel: ch });
  const registry = {
    getProvider: (id) => byId.get(id) || null,
    listProviderModules: () => mods,
    channelChoiceOf: (spec) => (spec && spec.channelChoice === "at-bill" ? "at-bill" : "at-setup"),
    canCheckChannelsOf: (m) => !!m && typeof m.checkChannels === "function",
    canPairOf: (m) => !!m && typeof m.pair === "function" && typeof m.unpair === "function",
    canCancelOf: (m) => !!m && typeof m.cancelQR === "function",
    isHiddenChannel: (c) => !!c && c.sellable === false,
    ownershipOf: (spec) => (spec && spec.connection && spec.connection.ownership ? { ...spec.connection.ownership } : null),
    findChannel: (id) => { const h = index.get(id); return h ? { provider: h.provider, connection: h.provider.spec.connection, channel: h.channel } : null; },
  };
  return { registry, calls, mods };
}

function makeRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
async function call(handler, req) {
  const res = makeRes();
  await handler(req, res);
  return res;
}

const OWNER = Object.freeze({ shopId: "shopA", uid: "u-owner", role: "owner", rights: [] });
const STAFF = Object.freeze({ shopId: "shopA", uid: "u-staff", role: "staff", rights: [] });
const ADMIN = Object.freeze({ shopId: "shopA", uid: "u-company", role: "owner", rights: [], byAdmin: true });
const NOW = new Date("2026-11-10T03:00:00.000Z");

module.exports = { TEST_KEY, NOW, makeStore, installFakeFirebase, sealTest, beamSign, makeRegistry, makeRes, call, OWNER, STAFF, ADMIN };
