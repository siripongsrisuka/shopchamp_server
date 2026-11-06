// pos/gateway/providers/index.js — ทะเบียนเจ้ารับชำระ (ก้อน 7 · DEV-0001 · ยกจากพี่น้อง)
// ──────────────────────────────────────────────────────────────────────────────
// ไฟล์นี้ = คำประกาศ ไม่ใช่โค้ดทำงาน: รวม `spec` ของทุกเจ้าไว้ที่เดียว แล้วเปิดฟังก์ชันค้นให้ handler ใช้ร่วมกัน
//   เพิ่มเจ้าใหม่ = เพิ่มไฟล์ + 1 บรรทัดใน MODULES (ไม่แตะ handler · ไม่แตะจอ)
//
// spec 3 ชั้น
//   ① ตัวเจ้า      { id, labelKey, labelFallback, runtime:'server'|'device', channelChoice? }
//   ② การเชื่อมต่อ connection: { fields:[{key,labelKey,labelFallback,required,secret?}], test:{kind,note}, ownership? }
//   ③ ช่องทางขาย  channels: [{channelId, nameKey, nameFallback, tranType?, qrKind?, lastKnownAvailable, sellable?}]
//   1 การเชื่อมต่อ → หลายช่องทางขาย (NTT ใช้ TID + รหัสผ่านชุดเดียวครอบทุกกระเป๋า)
//   labelKey/nameKey = i18n key (ASCII มีจุด) · labelFallback/nameFallback = ข้อความไทยสำรอง บังคับคู่กันทุกแถว
//     (ทะเบียนอยู่ที่เซิร์ฟเวอร์ คำแปลอยู่ในแอป ⇒ เจ้าใหม่ขึ้นจอได้ก่อนแอปรุ่นใหม่ออก)
//
// 🔐 ช่องลับ (decision ก้อน 7 · ต่างจากพี่น้อง): ประกาศ `secret: true` · ❌ ห้ามมี `store` ทุกรูป
//   handler เข้ารหัสด้วย secretBox.js ตอนเก็บ และถอดเป็นค่าดิบก่อนยื่นให้ provider
//   ⇒ config ที่ provider ได้ = ค่าที่ร้านพิมพ์ · เจ้าที่ต้อง hash (NTT) hash เองตอนยิง
//   ชื่อช่องใน config = `fields[].key` เป๊ะ · ช่องไม่บังคับที่ร้านไม่กรอก = ไม่มีใน config เลย
//
// 📜 สัญญาที่ทุกเจ้าทำตาม
//   createQR({channel, config, amount, referenceId, shopId}) → {ok:true,data:{providerRef,chargeId,qrPayload,qrKind}} | {ok:false,error:{code,message}}
//   inquiry({channel, config, providerRef, expectedAmount}) → {ok:true,data:{state,amountPaid,raw}}
//     state ∈ waiting|paid|closed|error|amount_mismatch · expectedAmount (บาท) ไม่บังคับ
//   testConnection({config, shopId}) → {ok:true,data:{verifiedFields,note}} · ❌ ห้ามสร้างรายการเงิน
//     บังคับเมื่อ runtime:'server' และ test.kind ∈ auth|query-nonexistent
//   cancelQR({channel, config, providerRef}) ไม่บังคับ (kbank-qr · beam-bolt) · checkChannels({config}) ไม่บังคับ (ntt)
//   pair({pairingCode}) / unpair({[ownership.field]}) ต้องมาเป็นคู่ + ประกาศ connection.ownership {field, registry}
//   ความสามารถ (canCancel/canPair/canCheckChannels) derive จากฟังก์ชันจริง ❌ ห้ามประกาศในสเปก
//
// channelChoice: at-setup (ติ๊กกระเป๋าบนจอตั้งค่า · ค่าตั้งต้น) | at-bill (เลือกกระเป๋าตอนขาย · ntt-edc beam-bolt)
//   ทะเบียนยังเก็บรายการกระเป๋าครบทุกแถวเสมอ (modal ตอนขายกางจากรายการนี้)
// runtime: server = เซิร์ฟเวอร์ยิงเอง (ต้องมี createQR+inquiry) · device = แอปคุยกับเครื่อง EDC ในร้าน (ไม่มี createQR)
// เส้นขาย vs หน้าตั้งค่า: getChannel/listSellableChannels = เฉพาะที่ขายได้ · listProviders = ครบทุกเจ้า ·
//   findChannel = ไม่สนสถานะ (ใช้กับรายการที่ออกไปแล้ว: inquire / webhook)
"use strict";

const QR_KINDS = ["text", "image"];
const STATES = ["waiting", "paid", "closed", "error", "amount_mismatch"];
const RUNTIMES = ["server", "device"];
const CHANNEL_CHOICES = ["at-setup", "at-bill"];
const DEFAULT_CHANNEL_CHOICE = "at-setup";
/** วิธีพิสูจน์ว่าบัญชีที่ร้านกรอกใช้ได้จริง */
const TEST_KINDS = [
  "auth", // ขอ token/ล็อกอิน — ไม่มีเงินเคลื่อน
  "query-nonexistent", // ถามสถานะรายการที่ไม่มีจริง แล้วดูว่าเจ้ารับรู้ตัวตนเราไหม
  "device-ping", // runtime:'device' — แอปเคาะเครื่องในร้านเอง
  "none", // พิสูจน์ล่วงหน้าไม่ได้จริง ๆ — ต้องเขียนเหตุใน note
];
/** i18n key = ASCII + มีจุดอย่างน้อย 1 */
const I18N_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]+$/;

// ➕ เพิ่มเจ้าใหม่ = เพิ่ม 1 บรรทัดตรงนี้ · ❌ ไม่มี kbank-edc (Pack: EDC = NTT เท่านั้น รายจุดขาย)
const MODULES = ["./ntt", "./ntt-edc", "./kbank-qr", "./beam-bolt", "./posxpay"];

/** ค่าที่ใช้จริงของ channelChoice — จุดเดียวที่รู้ว่า "ไม่ประกาศ" แปลว่าอะไร */
function channelChoiceOf(spec) {
  const v = spec && spec.channelChoice;
  return CHANNEL_CHOICES.includes(v) ? v : DEFAULT_CHANNEL_CHOICE;
}

/** ตรวจกระเป๋าจากเซิร์ฟเวอร์ได้ไหม — derive จากการมี checkChannels() จริง (ห้ามเขียนเกณฑ์ซ้ำที่อื่น) */
function canCheckChannelsOf(mod) {
  return !!mod && typeof mod.checkChannels === "function";
}

/** ร้านจับคู่/ตัดเครื่องได้ไหม — ต้องมี pair() และ unpair() ครบคู่ */
function canPairOf(mod) {
  return !!mod && typeof mod.pair === "function" && typeof mod.unpair === "function";
}

/** ยกเลิก QR ที่ผู้ให้บริการได้ไหม — เจ้าที่ไม่มี API ยกเลิก (ntt · posxpay · ntt-edc) = handler ไม่แตะ process */
function canCancelOf(mod) {
  return !!mod && typeof mod.cancelQR === "function";
}

/** คำประกาศ "ค่าในช่องนี้เป็นของร้านได้ทีละร้าน" — ไม่ประกาศ = null · ผู้อ่านเรียกตัวนี้ ห้ามอ่าน spec ดิบ */
function ownershipOf(spec) {
  const o = spec && spec.connection && spec.connection.ownership;
  if (o === undefined || o === null) return null;
  return { field: o.field, registry: o.registry };
}

/** ช่องนี้เป็นค่าลับไหม — จุดเดียวที่อ่าน `secret` (handler ใช้ตัดสินว่าจะเข้ารหัส/ปิดบังค่าไหน) */
function isSecretField(field) {
  return !!field && field.secret === true;
}

/**
 * แถวสถานะรายกระเป๋าของร้าน — `stored[providerId]._status.channels[channelId]`
 *   stored = doc `shop/{shopId}/meta/paymentGateway` ทั้งก้อน · ขาดชั้นไหน/รูปเพี้ยน = null · ไม่ตีความอะไร
 */
function shopChannelStatusOf({ stored, providerId, channelId }) {
  const block = stored && typeof stored === "object" ? stored[providerId] : null;
  const st = block && typeof block === "object" ? block._status : null;
  const chs = st && typeof st === "object" ? st.channels : null;
  const row = chs && typeof chs === "object" ? chs[channelId] : null;
  return row && typeof row === "object" ? row : null;
}

/**
 * กระเป๋านี้เปิดสำหรับร้านไหม (กติกาเดียวกับฝั่งแอป · คัดลอกมาไว้ที่นี่ ไม่ผูก package ร่วม)
 *   ผลตรวจสดของร้าน `open` เป็น boolean = ใช้ค่านั้น (ชนะทะเบียนทั้ง 2 ทิศ) · ไม่มี = `lastKnownAvailable === true`
 */
function channelIsOpen(row, channel) {
  if (row && typeof row === "object" && typeof row.open === "boolean") return row.open;
  return !!channel && channel.lastKnownAvailable === true;
}

/** แถวนี้เจ้าประกาศว่าขายผ่านทะเบียนไม่ได้ (`sellable:false`) */
function isHiddenChannel(ch) {
  return !!ch && ch.sellable === false;
}

function assertSpec(spec, from) {
  const bad = (msg) => {
    throw new Error(`gateway/providers: spec ของ ${from} ไม่ถูกต้อง — ${msg}`);
  };
  const assertKey = (v, what) => {
    if (typeof v !== "string" || !I18N_KEY.test(v)) {
      bad(`${what} ต้องเป็น i18n key แบบจุด (ASCII เช่น "screens.paymentGateway.field.x") — ได้ ${JSON.stringify(v)}`);
    }
  };
  const assertFallback = (v, what) => {
    if (typeof v !== "string" || !v.trim()) bad(`${what} ต้องมีข้อความสำรอง (ไทย สั้น อ่านรู้เรื่อง) — ได้ ${JSON.stringify(v)}`);
    if (I18N_KEY.test(v)) bad(`${what} เป็นข้อความสำรองให้คนอ่าน ไม่ใช่ i18n key ซ้ำ — ได้ ${JSON.stringify(v)}`);
  };
  /** fallback = ของเพิ่มคู่กับ key ไม่ใช่ของแทน */
  const assertNotInsteadOfKey = (keyVal, fbVal, keyName, fbName) => {
    if (fbVal !== undefined && keyVal === undefined) bad(`ประกาศ \`${fbName}\` แต่ไม่มี \`${keyName}\``);
  };

  if (!spec || typeof spec !== "object") bad("ไม่มี export `spec`");
  if (!spec.id || typeof spec.id !== "string") bad("ต้องมี `id` เป็น string");

  // ชื่อเจ้า: `label` = ชื่อเก่า รับชั่วคราวแต่บังคับรูป i18n เท่ากัน
  assertNotInsteadOfKey(spec.labelKey !== undefined ? spec.labelKey : spec.label, spec.labelFallback, "labelKey", "labelFallback");
  if (spec.labelKey === undefined && spec.label === undefined) bad("ต้องมี `labelKey` (i18n key ของชื่อเจ้า)");
  if (spec.labelKey !== undefined && spec.label !== undefined && spec.labelKey !== spec.label) {
    bad("`labelKey` กับ `label` ไม่ตรงกัน ⇒ เหลือ `labelKey` ตัวเดียว");
  }
  assertKey(spec.labelKey !== undefined ? spec.labelKey : spec.label, spec.labelKey !== undefined ? "labelKey" : "label (เปลี่ยนเป็น `labelKey`)");
  assertFallback(spec.labelFallback, "labelFallback");
  if (!RUNTIMES.includes(spec.runtime)) bad(`ต้องประกาศ \`runtime\` เป็น ${RUNTIMES.join("|")}`);

  // สะกดผิด = ดังตั้งแต่ cold start ไม่ใช่ตกเป็นค่าตั้งต้นเงียบ ๆ
  if (spec.channelChoice !== undefined && !CHANNEL_CHOICES.includes(spec.channelChoice)) {
    bad(`\`channelChoice\` ต้องเป็น ${CHANNEL_CHOICES.join("|")} — ได้ ${JSON.stringify(spec.channelChoice)}`);
  }
  for (const k of ["canCheckChannels", "canPair", "canCancel"]) {
    if (spec[k] !== undefined) bad(`\`${k}\` ห้ามประกาศในสเปก — derive จากฟังก์ชันจริง (ประกาศเอง = โกหกได้ + drift เงียบ)`);
  }

  // ── ② การเชื่อมต่อ ──
  if (spec.configKeys !== undefined) bad("`configKeys` = โครงเก่า ⇒ ย้ายไป `connection.fields`");
  if (!spec.connection || typeof spec.connection !== "object") bad("ต้องมี `connection`");
  if (!Array.isArray(spec.connection.fields)) bad("`connection.fields` ต้องเป็น array");
  const fieldKeys = new Set();
  for (const f of spec.connection.fields) {
    if (!f || typeof f.key !== "string" || !f.key) bad("connection.fields[].key ต้องเป็น string ที่ไม่ว่าง");
    if (fieldKeys.has(f.key)) bad(`connection.fields[].key ซ้ำ — ${f.key}`);
    fieldKeys.add(f.key);
    assertNotInsteadOfKey(f.labelKey, f.labelFallback, `connection.fields[${f.key}].labelKey`, `connection.fields[${f.key}].labelFallback`);
    assertKey(f.labelKey, `connection.fields[${f.key}].labelKey`);
    assertFallback(f.labelFallback, `connection.fields[${f.key}].labelFallback`);
    if (typeof f.required !== "boolean") bad(`connection.fields[${f.key}].required ต้องเป็น true/false ให้ชัด`);
    // 🔐 ก้อน 7: ไม่มีวิธีเก็บแบบ hash/ค่าดิบอีกแล้ว — ค่าลับทุกตัวเข้ากล่อง secretBox
    if (Object.prototype.hasOwnProperty.call(f, "store")) {
      bad(`connection.fields[${f.key}].store ห้ามประกาศ — ค่าลับให้ใช้ \`secret: true\` (เข้ารหัสด้วย secretBox) · ค่าไม่ลับไม่ต้องประกาศอะไร`);
    }
    if (f.secret !== undefined && f.secret !== true) bad(`connection.fields[${f.key}].secret ต้องเป็น true หรือไม่ประกาศ`);
  }

  // ownership: field ต้องเป็นช่องที่ประกาศจริง · registry = ชื่อ collection
  const own = spec.connection.ownership;
  if (own !== undefined && own !== null) {
    if (typeof own !== "object" || Array.isArray(own)) bad("`connection.ownership` ต้องเป็น object { field, registry }");
    if (typeof own.field !== "string" || !fieldKeys.has(own.field)) {
      bad(`connection.ownership.field ต้องเป็นชื่อช่องที่ประกาศใน connection.fields — ได้ ${JSON.stringify(own.field)}`);
    }
    if (typeof own.registry !== "string" || !own.registry.trim() || own.registry.includes("/")) {
      bad(`connection.ownership.registry ต้องเป็นชื่อ collection (ไม่ว่าง · ไม่มี "/") — ได้ ${JSON.stringify(own.registry)}`);
    }
  }

  // ปุ่มทดสอบ: note ต้องพูดถึงทุกช่องที่บังคับ
  const t = spec.connection.test;
  if (!t || typeof t !== "object") bad("ต้องมี `connection.test`");
  if (!TEST_KINDS.includes(t.kind)) bad(`connection.test.kind ต้องเป็น ${TEST_KINDS.join("|")}`);
  if (typeof t.note !== "string" || !t.note.trim()) bad("connection.test.note ต้องเขียนว่าทดสอบแล้วครอบ/ไม่ครอบ field ไหน");
  if (t.kind !== "none") {
    for (const f of spec.connection.fields) {
      if (f.required && !t.note.includes(f.key)) bad(`connection.test.note ไม่ได้พูดถึงช่องบังคับ "${f.key}"`);
    }
  }

  // ── ③ ช่องทางขาย ──
  if (!Array.isArray(spec.channels) || spec.channels.length === 0) bad("`channels` ต้องเป็น array และมีอย่างน้อย 1 ช่องทาง");
  for (const ch of spec.channels) {
    if (!ch || typeof ch.channelId !== "string" || !ch.channelId) bad("channels[].channelId ต้องเป็น string ที่ไม่ว่าง");
    if (ch.name !== undefined) bad(`channels[${ch.channelId}].name = โครงเก่า ⇒ ใช้ \`nameKey\``);
    assertNotInsteadOfKey(ch.nameKey, ch.nameFallback, `channels[${ch.channelId}].nameKey`, `channels[${ch.channelId}].nameFallback`);
    assertKey(ch.nameKey, `channels[${ch.channelId}].nameKey`);
    assertFallback(ch.nameFallback, `channels[${ch.channelId}].nameFallback`);
    if (ch.qrKind && !QR_KINDS.includes(ch.qrKind)) bad(`channels[${ch.channelId}].qrKind ต้องเป็น ${QR_KINDS.join("|")}`);
    if (ch.available !== undefined) bad(`channels[${ch.channelId}].available = ชื่อเก่า ⇒ ใช้ \`lastKnownAvailable\``);
    if (typeof ch.lastKnownAvailable !== "boolean") bad(`channels[${ch.channelId}].lastKnownAvailable ต้องเป็น true/false ให้ชัด`);
    if (ch.sellable !== undefined && typeof ch.sellable !== "boolean") bad(`channels[${ch.channelId}].sellable ต้องเป็น true/false`);
  }
}

function assertProvider(mod, from) {
  if (!mod || typeof mod !== "object") throw new Error(`gateway/providers: ${from} ไม่ได้ export อะไรเลย`);
  assertSpec(mod.spec, from);
  if (mod.spec.runtime === "server") {
    for (const fn of ["createQR", "inquiry"]) {
      if (typeof mod[fn] !== "function") throw new Error(`gateway/providers: ${from} (runtime:server) ไม่มีฟังก์ชัน ${fn}()`);
    }
    const kind = mod.spec.connection.test.kind;
    if ((kind === "auth" || kind === "query-nonexistent") && typeof mod.testConnection !== "function") {
      throw new Error(`gateway/providers: ${from} ประกาศ connection.test.kind='${kind}' แต่ไม่มี testConnection()`);
    }
  }
  const hasPair = typeof mod.pair === "function";
  const hasUnpair = typeof mod.unpair === "function";
  if (hasPair !== hasUnpair) {
    throw new Error(`gateway/providers: ${from} มี ${hasPair ? "pair()" : "unpair()"} แต่ไม่มี ${hasPair ? "unpair()" : "pair()"} — ต้องมาเป็นคู่`);
  }
  if (hasPair && !ownershipOf(mod.spec)) {
    throw new Error(`gateway/providers: ${from} มี pair()/unpair() แต่ไม่ประกาศ connection.ownership { field, registry }`);
  }
}

/** ตัวประกอบทะเบียน = pure (รับ module เป็น array) ⇒ เทสฉีดเจ้าปลอมได้ ตรรกะชุดเดียว */
function buildRegistry(modules) {
  const registry = new Map(); // providerId -> module
  const channelIndex = new Map(); // channelId -> { provider, channel }

  for (const mod of modules) {
    const from = (mod && mod.spec && mod.spec.id) || "(ไม่มีชื่อ)";
    assertProvider(mod, from);
    // ค่าเดียว 2 ชื่อ (label ↔ labelKey) · เติม channelChoice ที่ใช้จริงตั้งแต่ลงทะเบียน
    if (mod.spec.labelKey === undefined) mod.spec.labelKey = mod.spec.label;
    else if (mod.spec.label === undefined) mod.spec.label = mod.spec.labelKey;
    mod.spec.channelChoice = channelChoiceOf(mod.spec);
    if (registry.has(mod.spec.id)) throw new Error(`gateway/providers: providerId ซ้ำ — ${mod.spec.id}`);
    registry.set(mod.spec.id, mod);
    for (const channel of mod.spec.channels) {
      if (channelIndex.has(channel.channelId)) throw new Error(`gateway/providers: channelId ซ้ำข้ามเจ้า — ${channel.channelId}`);
      channelIndex.set(channel.channelId, { provider: mod, channel });
    }
  }

  /**
   * เส้นขายแบบบอกเหตุผล → {ok:true, provider, connection, channel} | {ok:false, reason:'unknown_channel'|'channel_not_server_runtime', fromRegistry?}
   *   shopChannelStatus = แถว `_status.channels[channelId]` ของร้าน (ไม่ส่ง = ใช้ทะเบียน)
   *   เช็ค runtime ก่อน · at-bill ผ่านทะเบียนเสมอ (สวิตช์ enabled รายร้านเป็นหน้าที่ handler)
   *   at-setup: ผลตรวจสด `open` ชนะทะเบียน 2 ทิศ (channelIsOpen)
   */
  function resolveSalesChannel(channelId, shopChannelStatus) {
    const hit = channelIndex.get(channelId);
    if (!hit) return { ok: false, reason: "unknown_channel" };
    if (hit.provider.spec.runtime !== "server") return { ok: false, reason: "channel_not_server_runtime" };
    const three = { provider: hit.provider, connection: hit.provider.spec.connection, channel: hit.channel };
    if (channelChoiceOf(hit.provider.spec) === "at-bill") return { ok: true, ...three };
    const live = shopChannelStatus && typeof shopChannelStatus === "object" && typeof shopChannelStatus.open === "boolean";
    if (!channelIsOpen(shopChannelStatus, hit.channel)) {
      // fromRegistry = คำตัดสินมาจากค่าตั้งต้นในทะเบียน (ยังไม่เห็นผลตรวจของร้าน)
      return { ok: false, reason: "unknown_channel", fromRegistry: !live, ...three };
    }
    return { ok: true, ...three };
  }

  /** เส้นขาย: {provider, connection, channel} หรือ null */
  function getChannel(channelId, shopChannelStatus) {
    const r = resolveSalesChannel(channelId, shopChannelStatus);
    return r.ok ? { provider: r.provider, connection: r.connection, channel: r.channel } : null;
  }

  /** ค้นแบบไม่สนสถานะ/runtime — รายการที่ออกไปแล้ว (inquire / webhook) · ไม่เจอ = null */
  function findChannel(channelId) {
    const hit = channelIndex.get(channelId);
    return hit ? { provider: hit.provider, connection: hit.provider.spec.connection, channel: hit.channel } : null;
  }

  /** หน้าตั้งค่า: ทุกช่องทางทุกเจ้า (แบน) ติด providerId + runtime + channelChoice */
  function listChannels() {
    const out = [];
    for (const { provider, channel } of channelIndex.values()) {
      out.push({ ...channel, providerId: provider.spec.id, runtime: provider.spec.runtime, channelChoice: channelChoiceOf(provider.spec) });
    }
    return out;
  }

  /** เส้นขาย: เฉพาะที่ขายได้ตามทะเบียน */
  function listSellableChannels() {
    return listChannels().filter((c) => !isHiddenChannel(c) && resolveSalesChannel(c.channelId).ok);
  }

  /** เส้นขายรายร้าน — ไม้บรรทัดเดียวกับ requestQr (resolveSalesChannel + แถวสถานะร้าน) · stored = null ได้ */
  function listSellableChannelsForShop(stored) {
    return listChannels().filter((c) => {
      if (isHiddenChannel(c)) return false;
      const live = shopChannelStatusOf({ stored, providerId: c.providerId, channelId: c.channelId });
      return resolveSalesChannel(c.channelId, live).ok;
    });
  }

  function getProvider(providerId) {
    return registry.get(providerId) || null;
  }

  /** หน้าตั้งค่า: spec เต็มของทุกเจ้า */
  function listProviders() {
    return [...registry.values()].map((m) => m.spec);
  }

  /** module ของทุกเจ้า (spec + ฟังก์ชันจริง) — ใช้ตอบ canX ที่ derive จากฟังก์ชัน */
  function listProviderModules() {
    return [...registry.values()];
  }

  return {
    getChannel,
    resolveSalesChannel,
    findChannel,
    listChannels,
    listSellableChannels,
    listSellableChannelsForShop,
    shopChannelStatusOf,
    channelIsOpen,
    getProvider,
    listProviders,
    listProviderModules,
    isHiddenChannel,
    isSecretField,
    channelChoiceOf,
    canCheckChannelsOf,
    canPairOf,
    canCancelOf,
    ownershipOf,
    QR_KINDS,
    STATES,
    RUNTIMES,
    TEST_KINDS,
    CHANNEL_CHOICES,
    DEFAULT_CHANNEL_CHOICE,
  };
}

// โหลดไฟล์เจ้าตามลิสต์ — ไฟล์ของเจ้าที่ยังไม่มีบนดิสก์ = ข้ามพร้อมเสียงเตือน (fail-closed: ช่องทางนั้นหาไม่เจอ)
//   error อื่น (spec ผิดโครง · require ข้างในพัง) = โยนต่อ ดังตั้งแต่ cold start
function loadModules(specPaths) {
  const out = [];
  for (const specPath of specPaths) {
    try {
      out.push(require(specPath));
    } catch (err) {
      const missingSelf = err && err.code === "MODULE_NOT_FOUND" && typeof err.message === "string" && err.message.includes(`'${specPath}'`);
      if (!missingSelf) throw err;
      // eslint-disable-next-line no-console
      console.warn(`gateway/providers: ยังไม่มีไฟล์ ${specPath} — ข้ามการลงทะเบียน`);
    }
  }
  return out;
}

module.exports = { ...buildRegistry(loadModules(MODULES)), buildRegistry, MODULES };
