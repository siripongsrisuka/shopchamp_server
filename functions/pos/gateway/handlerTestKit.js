// pos/gateway/handlerTestKit — ของใช้ร่วมของเทส handler เกตเวย์ (requestQr inquire cancelQr deviceSale stations simulate)
//   ไม่ใช่เทสเอง (ไม่ลงท้าย .test.js) · ❌ ไม่ require ในโค้ดจริง
//   ① ฐานปลอม: เก็บเอกสารตาม path เต็ม · บันทึกทุกการเขียน (LOG) · ปัดการอ่านหลังเขียนใน transaction เดียว (กติกา Firestore)
//   ② ทะเบียนเจ้าปลอม: API ชื่อเดียวกับ `providers/index.js` (resolveSalesChannel findChannel shopChannelStatusOf channelChoiceOf canCancelOf)
//      กติกาเปิดขายตามทะเบียนพี่น้อง: runtime ก่อน · at-bill ข้าม lastKnownAvailable · ผลตรวจของร้าน (open boolean) ชนะทะเบียน
//      ⇒ เทส handler ไม่ผูกกับจังหวะที่ทะเบียนจริงเขียนเสร็จ · ทะเบียนจริงพิสูจน์ที่สัญญา (harness)
//   ③ กุญแจทดสอบ (ไบต์ 0..31) · ของจริงอยู่ใน env ของ Functions เท่านั้น
"use strict";

const path = require("path");
const SB = require("./secretBox");

const TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

function makeStore() {
  const st = { DATA: {}, LOG: [] };
  const getDoc = (p) => st.DATA[p];
  const apply = (w) => {
    if (w.op === "set") st.DATA[w.path] = { ...w.v };
    else if (w.op === "update") {
      if (st.DATA[w.path] === undefined) throw new Error(`update ${w.path} ที่ไม่มีอยู่ (Firestore ปัด)`);
      st.DATA[w.path] = { ...st.DATA[w.path], ...w.v };
    }
  };
  const snapOf = (p, id) => { const d = getDoc(p); return { exists: d !== undefined, id, data: () => (d === undefined ? undefined : { ...d }) }; };
  const docRef = (collPath, id) => {
    const p = `${collPath}/${id}`;
    return {
      id, path: p,
      get: async () => snapOf(p, id),
      set: async (v) => { const w = { op: "set", path: p, v }; apply(w); st.LOG.push(w); },
      update: async (v) => { const w = { op: "update", path: p, v }; apply(w); st.LOG.push(w); },
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
      st.QUERIES = (st.QUERIES || 0) + 1;
      const prefix = `${collPath}/`;
      let docs = Object.keys(st.DATA)
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .filter((k) => filters.every(([f, v]) => st.DATA[k][f] === v))
        .map((k) => snapOf(k, k.slice(prefix.length)));
      if (lim != null) docs = docs.slice(0, lim);
      return { empty: !docs.length, docs };
    },
  });
  const coll = (collPath) => ({
    doc: (id) => docRef(collPath, id),
    where: (f, op, v) => query(collPath, [], null).where(f, op, v),
  });
  const db = {
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
      };
      const out = await fn(tx);
      for (const w of writes) apply(w);
      st.LOG.push(...writes);
      return out;
    },
  };
  st.db = db;
  st.reset = (data) => { st.DATA = { ...(data || {}) }; st.LOG = []; st.QUERIES = 0; };
  return st;
}

/** แทน functions/firebase ใน require.cache (ต้องเรียกก่อน require handler) */
function installFakeFirebase(store) {
  const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: store.db, admin: {} } };
}

// ── ทะเบียนเจ้าปลอม ──────────────────────────────────────────────────────────
function makeRegistry(P) {
  const calls = { createQR: [], inquiry: [], cancelQR: [] };
  const answer = (name) => async (args) => {
    calls[name].push(args);
    const a = P[name];
    if (a instanceof Error) throw a;
    return typeof a === "function" ? a(args) : a;
  };
  const mods = [
    {
      spec: {
        id: "ntt-h2h", runtime: "server",
        connection: { fields: [{ key: "terminalId", required: true }, { key: "password", required: true, secret: true }] },
        channels: [{ channelId: "nttThaiQr", qrKind: "text", lastKnownAvailable: true }, { channelId: "nttBblQr", qrKind: "text", lastKnownAvailable: false }],
      },
      createQR: answer("createQR"), inquiry: answer("inquiry"),
    },
    {
      spec: { id: "kbank-qr", runtime: "server", connection: { fields: [{ key: "merchantId", required: true }] }, channels: [{ channelId: "kbankThaiQr", qrKind: "text", lastKnownAvailable: true }] },
      createQR: answer("createQR"), inquiry: answer("inquiry"), cancelQR: answer("cancelQR"),
    },
    {
      spec: { id: "beam-bolt", runtime: "server", channelChoice: "at-bill", connection: { fields: [{ key: "boltConnectionId", required: true }] }, channels: [{ channelId: "beamBoltPromptPay", lastKnownAvailable: false }] },
      createQR: answer("createQR"), inquiry: answer("inquiry"), cancelQR: answer("cancelQR"),
    },
    {
      spec: { id: "ntt-edc", runtime: "device", channelChoice: "at-bill", connection: { fields: [{ key: "host", required: true }] }, channels: [{ channelId: "nttEdcCard", lastKnownAvailable: false }] },
    },
  ];
  const index = new Map();
  for (const m of mods) for (const ch of m.spec.channels) index.set(ch.channelId, { provider: m, channel: ch });
  const channelChoiceOf = (spec) => (spec && spec.channelChoice === "at-bill" ? "at-bill" : "at-setup");
  const registry = {
    channelChoiceOf,
    canCancelOf: (mod) => !!mod && typeof mod.cancelQR === "function",
    shopChannelStatusOf: ({ stored, providerId, channelId }) => {
      const b = stored && stored[providerId];
      const ch = b && b._status && b._status.channels;
      const row = ch && ch[channelId];
      return row && typeof row === "object" ? row : null;
    },
    findChannel: (id) => { const h = index.get(id); return h ? { provider: h.provider, connection: h.provider.spec.connection, channel: h.channel } : null; },
    resolveSalesChannel: (id, row) => {
      const h = index.get(id);
      if (!h) return { ok: false, reason: "unknown_channel" };
      if (h.provider.spec.runtime !== "server") return { ok: false, reason: "channel_not_server_runtime" };
      const three = { provider: h.provider, connection: h.provider.spec.connection, channel: h.channel };
      if (channelChoiceOf(h.provider.spec) === "at-bill") return { ok: true, ...three };
      const live = row && typeof row.open === "boolean" ? row.open : null;
      const open = live === null ? h.channel.lastKnownAvailable === true : live;
      return open ? { ok: true, ...three } : { ok: false, reason: "unknown_channel", fromRegistry: live === null, ...three };
    },
  };
  return { registry, calls };
}

/** กล่องกุญแจทดสอบของช่องลับ */
function sealTest(plain, binding) {
  const { key } = SB.readKey({ deps: { credKey: TEST_KEY } });
  return SB.seal(plain, binding, { key }).box;
}

function makeRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

async function callHandler(handler, body, shopAccess) {
  const res = makeRes();
  await handler({ body, shopAccess }, res);
  return res;
}

const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const STAFF = { shopId: "shopA", uid: "u-staff", role: "staff", rights: [] };
const ADMIN = { shopId: "shopA", uid: "u-company", role: "owner", rights: [], byAdmin: true };
// แพ็กเกจ Payment Gateway ที่ยังไม่หมด (packageGate.js) · seed ของเส้นที่ติดด่านต้องมีแถวนี้ใน shop/{shopId}.vip
const GATEWAY_VIP = Object.freeze([{ type: "gateway", expire: "2099-12-31T00:00:00.000Z" }]);

module.exports = { GATEWAY_VIP, TEST_KEY, makeStore, installFakeFirebase, makeRegistry, sealTest, makeRes, callHandler, OWNER, STAFF, ADMIN };
