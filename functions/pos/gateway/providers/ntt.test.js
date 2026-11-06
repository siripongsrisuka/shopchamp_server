// pos/gateway/providers/ntt.test — NTT DATA (NDPS) H2H · ยกเทสจากบ้านพี่น้อง + เทสของที่เปลี่ยน
// รัน: cd shopchamp_server/functions && node --test pos/gateway/providers/ntt.test.js
// 🔴 ห้ามออกเน็ต — ทุกการยิงผ่าน _setHttp (ของปลอม) · logger ผ่าน _setLogger · env ผ่าน _setEnv
"use strict";

const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const ntt = require("./ntt");

const { spec, createQR, inquiry, testConnection, checkChannels, parseNotify, hashPassword, makeOutTradeNo, mapTradeState, parseTimeEnd } = ntt;

// ── http ปลอม (จับทุก call) ─────────────────────────────────────────────────────
let CALLS = []; // {url, body, headers, kind}
let ROUTES = {}; // {auth|qr|query: (body, headers, nth) => response | {__throw}}
function kindOf(url) {
  if (/Check_User_Pass_v2/i.test(url)) return "auth";
  if (/ALL_QRCODE/i.test(url)) return "qr";
  if (/ALL_ORDERQUERY/i.test(url)) return "query";
  return "unknown";
}
async function fakeHttp(url, body, opts) {
  const kind = kindOf(url);
  const headers = (opts && opts.headers) || {};
  CALLS.push({ url, body, headers, kind, timeout: opts && opts.timeout });
  const h = ROUTES[kind];
  if (!h) throw new Error(`เทสไม่ได้ตั้ง route สำหรับ ${kind} (${url})`);
  const nth = CALLS.filter((c) => c.kind === kind).length;
  const out = await h(body, headers, nth);
  if (out && out.__throw) throw out.__throw;
  return { status: 200, data: out };
}
let LOGS = [];
const fakeLogger = {
  info: (msg, data) => LOGS.push({ level: "info", msg, data }),
  warn: (msg, data) => LOGS.push({ level: "warn", msg, data }),
  error: (msg, data) => LOGS.push({ level: "error", msg, data }),
};
let ENV = {};

// ── fixtures ────────────────────────────────────────────────────────────────────
const TID = "19912719"; // รูปเดียวกับ TID จริง ไม่ใช่ credential
const PW_PLAIN = "not-a-real-password"; // config ที่ provider รับ = plaintext (handler ถอดจาก secretBox แล้ว)
const PW_HASH = crypto.createHash("sha256").update(PW_PLAIN, "utf8").digest("base64"); // ค่าที่ต้องไปถึง NDPS
const CONFIG = { terminalId: TID, password: PW_PLAIN };
const COMPANY_ID = "118";
const TOKEN_1 = "TOKEN-AAA";
const TOKEN_2 = "TOKEN-BBB";

const chThaiQr = spec.channels.find((c) => c.channelId === "nttThaiQr");
const chShopee = spec.channels.find((c) => c.channelId === "nttShopeePay");
const chBblQr = spec.channels.find((c) => c.channelId === "nttBblQr");

const authOk = (token = TOKEN_1) => [{ token, company_id: COMPANY_ID, tid: TID, mid: "1000000000" }];
const authFail = [{ status: false, msg: "Error: Invalid username or password." }];
const S = (obj) => ({ STATUS: [obj] });
const INVALID_TOKEN = S({ result: false, message: "invalid TOKEN" });
const QUERY_CHANNEL_OPEN = S({ result: false, message: "Fail blank status", trade_state: "NOT_FOUND", tid: TID, mid: "010555615233087" });
const QUERY_CHANNEL_CLOSED = S({ result: false, message: "invalid TOKEN / not found transaction " });

function reset(routes) {
  CALLS = [];
  LOGS = [];
  ENV = {};
  ROUTES = Object.assign({ auth: () => authOk() }, routes || {});
  ntt._setHttp(fakeHttp);
  ntt._setLogger(fakeLogger);
  ntt._setEnv(ENV);
  ntt.__resetTokenCache();
  ntt.__resetConnectionTestCache();
}
const callsOf = (kind) => CALLS.filter((c) => c.kind === kind);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => reset({}));
after(() => {
  ntt._resetHttp();
  ntt._resetLogger();
  ntt._resetEnv();
});

// ═══ 1. hashPassword ═══════════════════════════════════════════════════════════
test("hashPassword('123456') ตรงกับค่าตัวอย่างในสเปก (SHA256 base64)", () => {
  assert.equal(hashPassword("123456"), "jZae727K08KaOmKSgOaGzww/XVqGr/PKEgIMkjrcbJI=");
});

test("hashPassword — utf8 ไม่ใช่ latin1 · รับเฉพาะ string ที่ไม่ว่าง", () => {
  const expected = crypto.createHash("sha256").update("รหัสผ่าน", "utf8").digest("base64");
  assert.equal(hashPassword("รหัสผ่าน"), expected);
  assert.throws(() => hashPassword(""), TypeError);
  assert.throws(() => hashPassword(123456), TypeError);
});

// ═══ 2. รหัสผ่าน plaintext → hash ตอนยิง (ของที่เปลี่ยนจากพี่น้อง) ════════════════════════
test("🔒 ค่าที่ส่งถึง NDPS = sha256-base64(plaintext) · plaintext ไม่อยู่ใน payload ใด ๆ เลย", async () => {
  reset({ qr: () => S({ result: true, code_url: "u", out_trade_no: "" }), query: () => S({ result: true, trade_state: "SUCCESS", amount: 1 }) });
  assert.equal((await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 })).ok, true);
  assert.equal((await inquiry({ channel: chThaiQr, config: CONFIG, providerRef: "1" })).ok, true);
  ntt.__resetConnectionTestCache();
  assert.equal((await testConnection({ config: CONFIG })).ok, true);
  assert.equal((await checkChannels({ config: CONFIG, channels: [chThaiQr] })).ok, true);

  const auths = callsOf("auth");
  assert.ok(auths.length >= 2);
  for (const a of auths) assert.equal(a.body.password, PW_HASH, "auth ต้องส่ง hash");
  assert.match(PW_HASH, /^[A-Za-z0-9+/]{43}=$/);
  // plaintext ห้ามโผล่ที่ไหนในคำขอ (body · header · url)
  const wire = JSON.stringify(CALLS);
  assert.equal(wire.includes(PW_PLAIN), false, "plaintext หลุดไปกับคำขอ");
  assert.equal(JSON.stringify(LOGS).includes(PW_PLAIN), false, "plaintext หลุดลง log");
});

test("🔒 hash ไบต์เดียวกับที่บ้านพี่น้องเก็บ (sha256 ของ String(ค่าที่กรอก) ไม่ trim)", async () => {
  // พี่น้องเก็บ applyStoreTransform(String(raw)) = sha256(utf8) → base64 · ไม่ trim ค่าที่กรอก
  for (const plain of ["123456", " มีช่องว่างหน้า-หลัง ", "รหัสไทย🙂"]) {
    reset({});
    await testConnection({ config: { terminalId: TID, password: plain } });
    const sibling = crypto.createHash("sha256").update(String(plain), "utf8").digest("base64");
    assert.equal(callsOf("auth")[0].body.password, sibling, `ค่าที่ยิงต้องตรงกับสูตรพี่น้อง (${JSON.stringify(plain)})`);
  }
});

test("🔒 config ที่หน้าตาเหมือน hash แล้ว ก็ยัง hash อีกรอบ (config ต้องเป็น plaintext เสมอ ไม่มีทางลัด)", async () => {
  reset({});
  await testConnection({ config: { terminalId: TID, password: PW_HASH } });
  assert.equal(callsOf("auth")[0].body.password, hashPassword(PW_HASH));
  assert.notEqual(callsOf("auth")[0].body.password, PW_HASH);
});

test("ชื่อช่องรหัสผ่าน = `password` ทางเดียว · `passwordHash` (ชื่อเก่า) = config_missing · รหัสว่าง/ช่องว่างล้วน = config_missing", async () => {
  reset({});
  assert.equal((await createQR({ channel: chThaiQr, config: { terminalId: TID, passwordHash: PW_HASH }, amount: 1 })).error.code, "config_missing");
  assert.equal((await createQR({ channel: chThaiQr, config: { terminalId: TID, password: "   " }, amount: 1 })).error.code, "config_missing");
  assert.equal((await createQR({ channel: chThaiQr, config: { terminalId: TID, password: 123 }, amount: 1 })).error.code, "config_missing");
  assert.equal(CALLS.length, 0, "ห้ามยิงอะไรเลย");
});

// ═══ 3. makeOutTradeNo ═════════════════════════════════════════════════════════
test("makeOutTradeNo — ตัวเลข 20 ตัว ขึ้นต้นด้วย TID 8 หลัก", () => {
  const v = makeOutTradeNo(TID);
  assert.match(v, /^\d{20}$/);
  assert.ok(v.startsWith(TID));
});

test("makeOutTradeNo — สุ่มไม่ซ้ำ · TID สั้นถูก pad · ตัวอักษรถูกตัด", () => {
  const set = new Set(Array.from({ length: 50 }, () => makeOutTradeNo(TID)));
  assert.ok(set.size > 45);
  assert.ok(makeOutTradeNo("123").startsWith("00000123"));
  assert.match(makeOutTradeNo("T1000001"), /^\d{20}$/);
  assert.throws(() => makeOutTradeNo("ABC"), TypeError);
});

// ═══ 4. mapTradeState / parseTimeEnd ═══════════════════════════════════════════
test("mapTradeState — ครบ 14 ค่าในตาราง", () => {
  const table = {
    USERPAYING: "waiting", WAIT_BUYER_PAY: "waiting", NOTPAY: "waiting",
    SUCCESS: "paid", TRADE_SUCCESS: "paid", TRADE_FINISHED: "paid", PAYMENT: "paid",
    REVOKED: "closed", REFUND: "closed", CLOSED: "closed", TRADE_CLOSED: "closed",
    PAYERROR: "error", NOT_FOUND: "error", ERROR: "error",
  };
  for (const [k, v] of Object.entries(table)) assert.equal(mapTradeState(k), v, k);
  assert.equal(Object.keys(table).length, 14);
});

test("mapTradeState — ไม่รู้จัก/ว่าง/ไม่ใช่ string = 'error' (ห้ามตก 'waiting') · normalize ตัวพิมพ์", () => {
  for (const bad of ["PENDING_REVIEW", "OK", "", "   ", null, undefined, 0, {}, [], true]) {
    assert.equal(mapTradeState(bad), "error", JSON.stringify(bad));
  }
  assert.equal(mapTradeState(" trade_success "), "paid");
  assert.equal(mapTradeState("Success"), "paid");
});

test("parseTimeEnd — 12/14/8 หลัก · ค่าเพี้ยน = null", () => {
  assert.equal(parseTimeEnd("202608131539"), "2026-08-13T15:39:00");
  assert.equal(parseTimeEnd("20260813155433"), "2026-08-13T15:54:33");
  assert.equal(parseTimeEnd("20230130"), "2023-01-30T00:00:00");
  for (const bad of ["2026081", "2026081315394", "", null, undefined, "19990101", "20261332"]) {
    assert.equal(parseTimeEnd(bad), null, JSON.stringify(bad));
  }
});

// ═══ 5. spec ═══════════════════════════════════════════════════════════════════
test("spec — id ntt-h2h · 9 กระเป๋า · เปิด 6 ปิด 3 · qrKind text · runtime server", () => {
  assert.equal(spec.id, "ntt-h2h");
  assert.equal(spec.runtime, "server");
  assert.equal(spec.channels.length, 9);
  const enabled = spec.channels.filter((c) => c.lastKnownAvailable === true).map((c) => c.tranType).sort();
  const disabled = spec.channels.filter((c) => c.lastKnownAvailable === false).map((c) => c.tranType).sort();
  assert.deepEqual(enabled, ["4", "9", "G", "L", "T", "X"]);
  assert.deepEqual(disabled, ["5", "B", "I"]);
  assert.ok(spec.channels.every((c) => c.qrKind === "text"));
  const ids = spec.channels.map((c) => c.channelId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.startsWith("ntt")));
});

test("🔒 spec.connection.fields — terminalId + password · password secret:true · ❌ ไม่มี store · ไม่มี env credential", () => {
  assert.deepEqual(spec.connection.fields.map((f) => f.key), ["terminalId", "password"]);
  const pw = spec.connection.fields.find((f) => f.key === "password");
  assert.equal(pw.secret, true);
  for (const f of spec.connection.fields) {
    assert.equal("store" in f, false, `${f.key} ห้ามมี store`);
    assert.equal("env" in f, false, `${f.key} ห้ามประกาศ env (credential มาจาก secretBox ทางเดียว)`);
    assert.equal(f.required, true);
  }
  assert.equal(spec.connection.fields.find((f) => f.key === "terminalId").secret, undefined);
});

test("spec — ไม่ประกาศ canCancel/canPair/canCheckChannels เอง (ทะเบียน derive จากฟังก์ชัน)", () => {
  for (const k of ["canCancel", "canPair", "canCheckChannels", "checkoutType", "configKeys"]) {
    assert.equal(spec[k], undefined, k);
  }
  assert.equal(typeof ntt.checkChannels, "function");
  assert.equal(ntt.cancelQR, undefined, "NTT ไม่มี API ยกเลิก QR");
  assert.equal(ntt.pair, undefined);
});

test("🌏 labelKey/nameKey = i18n key · มี fallback ทุกแถว · test.note เอ่ยทุกช่อง", () => {
  const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]+$/;
  assert.ok(KEY.test(spec.labelKey));
  assert.ok(spec.labelFallback);
  for (const f of spec.connection.fields) {
    assert.ok(KEY.test(f.labelKey), f.key);
    assert.ok(f.labelFallback, f.key);
  }
  for (const c of spec.channels) {
    assert.ok(KEY.test(c.nameKey), c.channelId);
    assert.ok(c.nameFallback, c.channelId);
  }
  assert.equal(new Set(spec.channels.map((c) => c.nameKey)).size, spec.channels.length);
  const t = spec.connection.test;
  assert.equal(t.kind, "auth");
  assert.ok(t.note.includes("Check_User_Pass_v2"));
  for (const f of spec.connection.fields) assert.ok(t.note.includes(f.key), f.key);
  assert.match(t.note, /2\/2/);
});

test("ทะเบียน providers/index.js รับเจ้านี้ได้ (ถ้ามีไฟล์แล้ว)", (t) => {
  let reg;
  try {
    reg = require("./index.js");
  } catch (e) {
    // ไฟล์ทะเบียน (หรือเจ้าอื่นที่ทะเบียนโหลด) ยังไม่ถูกเขียน = ข้าม · error อื่นให้แดง
    if (e && e.code === "MODULE_NOT_FOUND") {
      t.skip(`ทะเบียนยังโหลดไม่ได้: ${String(e.message).split("\n")[0]}`);
      return;
    }
    throw e;
  }
  if (typeof reg.buildRegistry !== "function") {
    t.skip("index.js ยังไม่มี buildRegistry");
    return;
  }
  assert.doesNotThrow(() => reg.buildRegistry([ntt]));
});

// ═══ 6. createQR — ทางสำเร็จ ═══════════════════════════════════════════════════
test("createQR สำเร็จ (ThaiQR) — auth 1 ครั้ง · company_id จาก auth · คืน QR", async () => {
  reset({ qr: () => S({ result: true, message: "Success", code_url: "00020101021129370016A0000006770101", prepay_id: "O2308131539", out_trade_no: "" }) });
  const r = await createQR({ channel: chThaiQr, config: CONFIG, amount: 1, referenceId: "pgabc" });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.match(r.data.providerRef, /^\d{20}$/);
  assert.ok(r.data.providerRef.startsWith(TID));
  assert.equal(r.data.qrPayload, "00020101021129370016A0000006770101");
  assert.equal(r.data.qrKind, "text");
  assert.equal(r.data.chargeId, "O2308131539");
  assert.equal(callsOf("auth").length, 1);
  const qr = callsOf("qr")[0];
  assert.equal(qr.body.tran_type, "T");
  assert.equal(qr.body.company_id, COMPANY_ID);
  assert.equal(qr.body.terminal_id, TID);
  assert.equal(qr.body.total_fee, "1.00");
  assert.equal(qr.body.out_trade_no, r.data.providerRef);
  assert.equal(qr.headers.tokenid, TOKEN_1);
  assert.equal(JSON.stringify(qr.body).includes("pgabc"), false, "referenceId ไม่ส่งให้ NTT");
  const au = callsOf("auth")[0];
  assert.equal(au.body.username, TID);
  assert.equal(au.body.terminal_id, TID);
  assert.equal(au.body.password, PW_HASH);
});

test("createQR — out_trade_no ที่ NTT คืนชนะของเรา · ไม่มี prepay_id = chargeId null", async () => {
  reset({ qr: () => S({ result: true, code_url: "https://x", out_trade_no: "88885555222747905312" }) });
  const r = await createQR({ channel: chShopee, config: CONFIG, amount: 25.5 });
  assert.equal(r.data.providerRef, "88885555222747905312");
  assert.equal(callsOf("qr")[0].body.total_fee, "25.50");
  assert.equal(callsOf("qr")[0].body.tran_type, "G");
  assert.equal(r.data.chargeId, null);
});

test("createQR — token ใช้ซ้ำ (ไม่ auth ใหม่ทุกครั้ง)", async () => {
  reset({ qr: () => S({ result: true, code_url: "u", out_trade_no: "" }) });
  await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  assert.equal(callsOf("auth").length, 1);
  assert.equal(callsOf("qr").length, 2);
});

// ═══ 7. createQR — ทางล้ม ═══════════════════════════════════════════════════════
test("createQR — กระเป๋าที่ทะเบียนบอกว่าปิด = ปัดก่อนแตะเน็ต", async () => {
  reset({ qr: () => S({ result: true, code_url: "u" }) });
  const r = await createQR({ channel: chBblQr, config: CONFIG, amount: 1 });
  assert.equal(r.error.code, "channel_not_enabled");
  assert.equal(CALLS.length, 0);
});

test("🔓 createQR — channelOpen:true ชนะทะเบียน (BBL tran_type 5 ส่ง out_trade_no ว่าง)", async () => {
  reset({ qr: () => S({ result: true, code_url: "https://bbl", out_trade_no: "55550000111122223333" }) });
  const r = await createQR({ channel: chBblQr, config: CONFIG, amount: 12, channelOpen: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(callsOf("qr")[0].body.tran_type, "5");
  assert.equal(callsOf("qr")[0].body.out_trade_no, "");
  assert.equal(r.data.providerRef, "55550000111122223333");
});

test("🔒 createQR — channelOpen:false ชนะทะเบียน · ไม่ใช่ boolean = ใช้ทะเบียน (fail-closed)", async () => {
  reset({ qr: () => S({ result: true, code_url: "u" }) });
  assert.equal((await createQR({ channel: chThaiQr, config: CONFIG, amount: 1, channelOpen: false })).error.code, "channel_not_enabled");
  assert.equal(CALLS.length, 0);
  for (const v of [undefined, null, "true", 1, {}]) {
    reset({ qr: () => S({ result: true, code_url: "u", out_trade_no: "1" }) });
    const off = await createQR({ channel: chBblQr, config: CONFIG, amount: 1, channelOpen: v });
    assert.equal(off.error.code, "channel_not_enabled", JSON.stringify(v));
    assert.equal(CALLS.length, 0);
    reset({ qr: () => S({ result: true, code_url: "u", out_trade_no: "1" }) });
    assert.equal((await createQR({ channel: chThaiQr, config: CONFIG, amount: 1, channelOpen: v })).ok, true);
  }
});

test("createQR — ยอดผิด / channel ผิดรูป / config ไม่ครบ = ปัดก่อนแตะเน็ต", async () => {
  for (const amount of [0, -5, NaN, "abc", null, undefined]) {
    reset({});
    const r = await createQR({ channel: chThaiQr, config: CONFIG, amount });
    assert.equal(r.error.code, "bad_amount", String(amount));
    assert.equal(CALLS.length, 0);
  }
  reset({});
  assert.equal((await createQR({ channel: {}, config: CONFIG, amount: 1 })).error.code, "bad_channel");
  assert.equal((await createQR({ channel: chThaiQr, config: {}, amount: 1 })).error.code, "config_missing");
  assert.equal((await createQR({ channel: chThaiQr, config: { terminalId: TID }, amount: 1 })).error.code, "config_missing");
  assert.equal((await createQR()).error.code, "bad_channel");
  assert.equal(CALLS.length, 0);
});

test("createQR — auth ถูกปฏิเสธ = auth_failed · ไม่ยิง QR", async () => {
  reset({ auth: () => authFail, qr: () => S({ result: true, code_url: "u" }) });
  const r = await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  assert.equal(r.error.code, "auth_failed");
  assert.match(r.error.message, /Invalid username or password/);
  assert.equal(callsOf("qr").length, 0);
});

test("createQR — result:false = ntt_error · ไม่มี code_url = bad_response", async () => {
  reset({ qr: () => S({ result: false, message: "Invalid amount" }) });
  let r = await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  assert.equal(r.error.code, "ntt_error");
  assert.equal(r.error.message, "Invalid amount");
  reset({ qr: () => S({ result: true, message: "Success", code_url: "" }) });
  r = await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  assert.equal(r.error.code, "bad_response");
});

test("createQR — HTTP 500 / timeout / เน็ตหลุด", async () => {
  const httpErr = Object.assign(new Error("Request failed"), { response: { status: 500, data: { message: "server down" } }, config: { headers: { tokenid: TOKEN_1 } } });
  reset({ qr: () => ({ __throw: httpErr }) });
  let r = await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  assert.equal(r.error.code, "ntt_http_500");
  assert.equal(r.error.status, 500);
  assert.equal(r.error.message, "server down");
  reset({ qr: () => ({ __throw: Object.assign(new Error("timeout of 20000ms exceeded"), { code: "ECONNABORTED" }) }) });
  assert.equal((await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 })).error.code, "ntt_timeout");
  reset({ qr: () => ({ __throw: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }) });
  assert.equal((await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 })).error.code, "ntt_network_error");
});

// ═══ 8. inquiry ════════════════════════════════════════════════════════════════
test("inquiry ThaiQR ก่อนจ่าย (NOT_FOUND) = 'error' ไม่ใช่ 'waiting'", async () => {
  reset({ query: () => S({ result: true, message: "000 Success", trade_state: "NOT_FOUND", amount: 0.0 }) });
  const r = await inquiry({ channel: chThaiQr, config: CONFIG, providerRef: "19912719000000000001" });
  assert.equal(r.data.state, "error");
  const q = callsOf("query")[0];
  assert.equal(q.body.out_trade_no, "19912719000000000001");
  assert.equal(q.body.tran_type, "T");
  assert.equal(q.body.company_id, COMPANY_ID);
});

test("inquiry หลังจ่าย — SUCCESS (12 หลัก) / TRADE_SUCCESS (14 หลัก · amount สตริง) = paid", async () => {
  reset({ query: () => S({ result: true, trade_state: "SUCCESS", amount: 1, time_end: "202608131539", transaction_id: "TMB123" }) });
  let r = await inquiry({ channel: chThaiQr, config: CONFIG, providerRef: "1" });
  assert.equal(r.data.state, "paid");
  assert.equal(r.data.amountPaid, 1);
  assert.equal(r.data.paidAt, "2026-08-13T15:39:00");
  assert.equal(r.data.raw.transaction_id, "TMB123");
  reset({ query: () => S({ result: true, trade_state: "TRADE_SUCCESS", amount: "1", time_end: "20260813155433" }) });
  r = await inquiry({ channel: chShopee, config: CONFIG, providerRef: "2" });
  assert.equal(r.data.state, "paid");
  assert.equal(r.data.amountPaid, 1);
  assert.equal(r.data.paidAt, "2026-08-13T15:54:33");
});

test("inquiry WAIT_BUYER_PAY = waiting · paidAt null", async () => {
  reset({ query: () => S({ result: true, trade_state: "WAIT_BUYER_PAY", amount: 1 }) });
  const r = await inquiry({ channel: chShopee, config: CONFIG, providerRef: "1" });
  assert.equal(r.data.state, "waiting");
  assert.equal(r.data.paidAt, null);
});

test("💰 ยังไม่จ่ายแต่ NTT ส่ง amount มา → amountPaid null · จ่ายแล้ว = คืนยอด", async () => {
  for (const st of ["WAIT_BUYER_PAY", "NOTPAY", "CLOSED", "REVOKED", "ค่าที่ยังแปลไม่ออก"]) {
    reset({ query: () => S({ result: true, trade_state: st, amount: 500 }) });
    const r = await inquiry({ channel: chShopee, config: CONFIG, providerRef: "1" });
    assert.notEqual(r.data.state, "paid");
    assert.equal(r.data.amountPaid, null, st);
  }
  reset({ query: () => S({ result: true, trade_state: "TRADE_SUCCESS", amount: 500 }) });
  assert.equal((await inquiry({ channel: chShopee, config: CONFIG, providerRef: "1" })).data.amountPaid, 500);
});

test("inquiry — CLOSED/REVOKED = closed · สถานะใหม่ = error", async () => {
  for (const [st, want] of [["CLOSED", "closed"], ["REVOKED", "closed"], ["SOMETHING_NEW", "error"]]) {
    reset({ query: () => S({ result: true, trade_state: st, amount: 1 }) });
    assert.equal((await inquiry({ channel: chThaiQr, config: CONFIG, providerRef: "1" })).data.state, want);
  }
});

test("inquiry — ไม่มี providerRef = bad_input ก่อนแตะเน็ต · result:false ไม่มี trade_state = ntt_error", async () => {
  reset({ query: () => S({ result: true, trade_state: "SUCCESS" }) });
  assert.equal((await inquiry({ channel: chThaiQr, config: CONFIG, providerRef: "  " })).error.code, "bad_input");
  assert.equal(CALLS.length, 0);
  reset({ query: () => S({ result: false, message: "Transaction not found" }) });
  const r = await inquiry({ channel: chThaiQr, config: CONFIG, providerRef: "1" });
  assert.equal(r.error.code, "ntt_error");
  assert.equal(r.error.message, "Transaction not found");
  reset({ query: () => S({ result: true }) });
  assert.equal((await inquiry({ channel: chThaiQr, config: CONFIG, providerRef: "1" })).error.code, "bad_response");
});

test("inquiry — ยังตามกระเป๋าที่ทะเบียนปิดได้ (บิลเก่าต้องไม่ค้าง)", async () => {
  reset({ query: () => S({ result: true, trade_state: "TRADE_SUCCESS", amount: 1 }) });
  const r = await inquiry({ channel: chBblQr, config: CONFIG, providerRef: "1" });
  assert.equal(r.data.state, "paid");
});

// ═══ 9. invalid TOKEN ═══════════════════════════════════════════════════════════
test("invalid TOKEN → re-auth 1 ครั้งแล้วสำเร็จด้วย token ใหม่", async () => {
  reset({
    auth: (b, h, nth) => authOk(nth === 1 ? TOKEN_1 : TOKEN_2),
    qr: (b, h, nth) => (nth === 1 ? S({ result: true, code_url: "warm", out_trade_no: "" }) : nth === 2 ? INVALID_TOKEN : S({ result: true, code_url: "QR-OK", out_trade_no: "" })),
  });
  await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  const r = await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  assert.equal(r.data.qrPayload, "QR-OK");
  assert.equal(callsOf("auth").length, 2);
  assert.equal(callsOf("qr").length, 3);
  assert.equal(callsOf("qr")[2].headers.tokenid, TOKEN_2);
});

test("invalid TOKEN ซ้ำหลัง re-auth = channel_not_enabled · ไม่วน", async () => {
  reset({ auth: (b, h, nth) => authOk(nth === 1 ? TOKEN_1 : TOKEN_2), qr: () => INVALID_TOKEN });
  const r = await createQR({ channel: chShopee, config: CONFIG, amount: 1 });
  assert.equal(r.error.code, "channel_not_enabled");
  assert.ok(callsOf("auth").length <= 2);
  assert.ok(callsOf("qr").length <= 2);
});

test("invalid TOKEN บน inquiry ก็ re-auth ครั้งเดียว · re-auth ล้ม = auth_failed", async () => {
  reset({
    auth: (b, h, nth) => authOk(nth === 1 ? TOKEN_1 : TOKEN_2),
    query: (b, h, nth) => (nth === 1 ? INVALID_TOKEN : S({ result: true, trade_state: "SUCCESS", amount: 1 })),
  });
  const r = await inquiry({ channel: chThaiQr, config: CONFIG, providerRef: "1" });
  assert.equal(r.data.state, "paid");
  assert.equal(callsOf("query").length, 2);

  reset({
    auth: (b, h, nth) => (nth === 1 ? authOk(TOKEN_1) : authFail),
    qr: (b, h, nth) => (nth === 1 ? S({ result: true, code_url: "warm", out_trade_no: "" }) : INVALID_TOKEN),
  });
  await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  assert.equal((await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 })).error.code, "auth_failed");
});

// ═══ 10. ความลับห้ามรั่ว ════════════════════════════════════════════════════════
test("error ไม่มี token / hash / plaintext / err.config ติดไป", async () => {
  const leaky = Object.assign(new Error("boom"), {
    response: { status: 502, data: { message: "bad gateway" } },
    config: { headers: { tokenid: TOKEN_1 }, data: JSON.stringify({ password: PW_HASH }) },
    request: { _header: `tokenid: ${TOKEN_1}` },
  });
  reset({ qr: () => ({ __throw: leaky }) });
  const r = await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  const dump = JSON.stringify(r);
  for (const s of [TOKEN_1, PW_HASH, PW_PLAIN]) assert.equal(dump.includes(s), false, s);
  assert.deepEqual(Object.keys(r.error).sort(), ["code", "message", "status"]);
});

test("ไฟล์ provider ไม่มี console.* · ไม่อ่าน credential จาก env · env ที่อ่าน = endpoint/timeout/จังหวะเบรก", () => {
  const src = require("fs").readFileSync(require.resolve("./ntt.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/console\./.test(code));
  assert.ok(!/NTT_(UAT_)?(TID|MID|PASSWORD)/.test(code), "ห้ามอ่าน credential จาก env");
  assert.ok(!/19912719/.test(code), "ห้าม hardcode TID");
  assert.ok(!/process\.env\.[A-Z]/.test(code), "env ต้องผ่าน env() ที่เปลี่ยนได้ ไม่อ่าน process.env ตรง");
  const envReads = [...code.matchAll(/env\(\)\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(envReads)].sort(), ["NTT_BASE_URL", "NTT_CHANNEL_CHECK_COOLDOWN_MS", "NTT_ENV", "NTT_TEST_THROTTLE_MS", "NTT_TIMEOUT_MS"]);
  assert.ok(!/require\(["']axios["']\)\s*;/.test(code), "axios โหลดตอนใช้ผ่าน http ที่เปลี่ยนได้เท่านั้น");
});

// ═══ 11. env / endpoint ═════════════════════════════════════════════════════════
test("endpoint — default production · NTT_ENV=uat สลับ path ทั้งชุด · NTT_BASE_URL override · timeout จาก env", async () => {
  reset({ qr: () => S({ result: true, code_url: "u", out_trade_no: "" }) });
  await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  assert.ok(callsOf("auth")[0].url.startsWith("https://payment.ghl.co.th/PAYMENT_AUTHENTICATION/"));
  assert.ok(!/_UAT/.test(callsOf("qr")[0].url));
  assert.equal(callsOf("qr")[0].timeout, 20000);

  reset({ qr: () => S({ result: true, code_url: "u", out_trade_no: "" }) });
  ntt._setEnv({ NTT_ENV: "uat", NTT_BASE_URL: "https://example.test/", NTT_TIMEOUT_MS: "1234" });
  await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  assert.equal(callsOf("auth")[0].url, "https://example.test/PAYMENT_AUTHENTICATION_UAT/api/WebServices/Check_User_Pass_v2");
  assert.equal(callsOf("qr")[0].url, "https://example.test/PAYMENTSERVICES_UAT/ALL_QRCODE.ASPX");
  assert.equal(callsOf("qr")[0].timeout, 1234);

  // ค่าแปลก = production (ไม่ไป UAT เงียบ ๆ)
  reset({ qr: () => S({ result: true, code_url: "u", out_trade_no: "" }) });
  ntt._setEnv({ NTT_ENV: "staging" });
  await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  assert.ok(!/_UAT/.test(callsOf("auth")[0].url));
});

test("_resetEnv กลับไปอ่าน process.env · _setHttp ปัดค่าที่ไม่ใช่ฟังก์ชัน", async () => {
  const before = process.env.NTT_BASE_URL;
  process.env.NTT_BASE_URL = "https://from-process-env.test";
  try {
    reset({ qr: () => S({ result: true, code_url: "u", out_trade_no: "" }) });
    ntt._resetEnv();
    await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
    assert.ok(callsOf("auth")[0].url.startsWith("https://from-process-env.test/"));
  } finally {
    if (before === undefined) delete process.env.NTT_BASE_URL;
    else process.env.NTT_BASE_URL = before;
  }
  assert.throws(() => ntt._setHttp(null), TypeError);
});

// ═══ 12. testConnection ═════════════════════════════════════════════════════════
test("🔒 testConnection สำเร็จ — auth อย่างเดียว · qr 0 · query 0", async () => {
  const r = await testConnection({ config: CONFIG });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.data.verifiedFields, ["terminalId", "password"]);
  assert.equal(r.data.companyId, COMPANY_ID);
  assert.ok(r.data.note.length > 10);
  assert.equal(r.data.throttled, false);
  assert.equal(callsOf("qr").length, 0);
  assert.equal(callsOf("query").length, 0);
  assert.equal(callsOf("auth").length, 1);
  assert.equal(callsOf("auth")[0].body.password, PW_HASH);
});

test("testConnection — TID/รหัสผิด = auth_failed · ไม่มีความลับหลุด · config ไม่ครบ = ปัดก่อนแตะเน็ต", async () => {
  reset({ auth: () => authFail });
  const r = await testConnection({ config: CONFIG, shopId: "shopA" });
  assert.equal(r.error.code, "auth_failed");
  assert.equal(JSON.stringify(r).includes(PW_HASH), false);
  assert.equal(JSON.stringify(r).includes(PW_PLAIN), false);
  reset({});
  assert.equal((await testConnection({ config: {} })).error.code, "config_missing");
  assert.equal((await testConnection({ config: { terminalId: TID } })).error.code, "config_missing");
  assert.equal((await testConnection()).error.code, "config_missing");
  assert.equal(CALLS.length, 0);
});

test("🔒 testConnection — กดรัวไม่ทะลุ · เปลี่ยนรหัสผ่าน = ยิงจริง · ผลล้มก็จำ", async () => {
  const a = await testConnection({ config: CONFIG });
  const b = await testConnection({ config: CONFIG });
  await testConnection({ config: CONFIG });
  assert.equal(callsOf("auth").length, 1);
  assert.equal(a.data.throttled, false);
  assert.equal(b.data.throttled, true);
  await testConnection({ config: { terminalId: TID, password: "another-not-real" } });
  assert.equal(callsOf("auth").length, 2);

  reset({ auth: () => authFail });
  await testConnection({ config: CONFIG });
  assert.equal((await testConnection({ config: CONFIG })).error.code, "auth_failed");
  assert.equal(callsOf("auth").length, 1);
});

test("testConnection — หมดอายุแล้วยิงใหม่ · 0 = ปิดการจำ · token ที่ได้ใช้ต่อในเส้นขาย", async () => {
  ntt._setEnv({ NTT_TEST_THROTTLE_MS: "1" });
  await testConnection({ config: CONFIG });
  await sleep(6);
  await testConnection({ config: CONFIG });
  assert.equal(callsOf("auth").length, 2);

  reset({});
  ntt._setEnv({ NTT_TEST_THROTTLE_MS: "0" });
  await testConnection({ config: CONFIG });
  await testConnection({ config: CONFIG });
  assert.equal(callsOf("auth").length, 2);

  reset({ qr: () => S({ result: true, code_url: "u", out_trade_no: "" }) });
  await testConnection({ config: CONFIG });
  await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  assert.equal(callsOf("auth").length, 1);
  assert.equal(callsOf("qr")[0].headers.tokenid, TOKEN_1);
});

// ═══ 13. checkChannels ══════════════════════════════════════════════════════════
const REC = (extra) => ({
  result: false, nonce_str: "", transaction_id: "", time_end: "", amount: 0, trade_state: "",
  cny_amount: 0, exchange_rate: 0, buyer_login_id: "", buyer_user_id: "",
  tid: "«ปกปิด»", mid: "«ปกปิด»", master_tid: "«ปกปิด»", master_mid: "«ปกปิด»",
  ref1: "", ref2: "", ref3: "", currency: null, pspname: null, paymentMethod: null, ...extra,
});
// คำตอบจริงครบ 9 กระเป๋า (6 เปิด / 3 ปิด) · มีตัวแทนทุกคลาสที่เกณฑ์เก่าเคยอ่านผิด
const REAL_WALLET_REPLIES = [
  ["nttThaiQr", true, REC({ message: "Fail blank status", trade_state: "NOT_FOUND" })],
  ["nttRabbitLinePay", true, REC({ message: "Fail 1150 Transaction record not found.", trade_state: "ERROR" })],
  ["nttShopeePay", true, REC({ message: "Fail not found transaction ", time_end: "20260829180429" })],
  ["nttAlipayPlus", true, REC({ message: "Fail paymentrequestid not found in alipay+ out_trade_no=«ปกปิด»249769949878, ref1=" })],
  ["nttTrueMoney", true, { result: false, message: "invalid input parameter json wrong format ! or Input string was not in a correct format." }],
  ["nttMaxMe", true, { result: false, message: "invalid input parameter json wrong format ! or Object reference not set to an instance of an object." }],
  ["nttBblQr", false, { result: false, message: "invalid TOKEN / not found transaction " }],
  ["nttWechat", false, { result: false, message: "invalid TOKEN / not found transaction " }],
  ["nttAtome", false, { result: false, message: "invalid TOKEN / not found transaction " }],
];

test("🔬 walletOpenFrom — ชุดควบคุมของจริง 9 กระเป๋า: 6 เปิด / 3 ปิด", () => {
  const wrong = REAL_WALLET_REPLIES.map(([id, expected, body]) => ({ id, expected, got: ntt.walletOpenFrom(body) })).filter((x) => x.got !== x.expected);
  assert.deepEqual(wrong, []);
});

test("🔬 walletOpenFrom — อ่านไม่ออก = null · invalid TOKEN ใน record เต็ม = เปิด · เปลือยข้อความอื่น = เปิด", () => {
  for (const v of [null, undefined, "", "ข้อความเปล่า", 0, [], {}]) assert.equal(ntt.walletOpenFrom(v), null, JSON.stringify(v));
  assert.equal(ntt.walletOpenFrom(REC({ message: "invalid TOKEN / not found transaction " })), true);
  assert.equal(ntt.walletOpenFrom({ result: false, message: "อะไรก็ไม่รู้" }), true);
  assert.equal(ntt.walletOpenFrom({ result: true, message: "Success" }), true);
});

test("🔬 checkChannels({config}) ไม่ส่ง channels = ตรวจครบ 9 ใน spec · 6 เปิด 3 ปิด · ไม่แตะ ALL_QRCODE", async () => {
  const byTran = new Map(spec.channels.map((c) => [c.tranType, c.channelId]));
  const replyOf = new Map(REAL_WALLET_REPLIES.map(([id, , body]) => [id, body]));
  reset({ query: (body) => S(replyOf.get(byTran.get(body.tran_type))) });
  const r = await checkChannels({ config: CONFIG });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const got = new Map(r.data.results.map((x) => [x.channelId, x.open]));
  for (const [id, expected] of REAL_WALLET_REPLIES) assert.equal(got.get(id), expected, id);
  assert.deepEqual(r.data.results.map((x) => x.channelId), spec.channels.map((c) => c.channelId), "เรียงตาม spec");
  assert.equal(callsOf("qr").length, 0);
  assert.equal(callsOf("query").length, 9);
  for (const q of callsOf("query")) {
    assert.match(q.body.out_trade_no, /^\d{20}$/);
    assert.equal(q.body.terminal_id, TID);
    assert.equal(q.body.company_id, COMPANY_ID);
  }
});

test("🔴 checkChannels — ขอ token สดก่อนเสมอ แม้มี token ใน cache", async () => {
  reset({ auth: (b, h, nth) => authOk(nth === 1 ? TOKEN_1 : TOKEN_2), qr: () => S({ result: true, code_url: "u", out_trade_no: "" }), query: () => QUERY_CHANNEL_OPEN });
  await createQR({ channel: chThaiQr, config: CONFIG, amount: 1 });
  await checkChannels({ config: CONFIG, channels: [chThaiQr] });
  assert.equal(callsOf("auth").length, 2);
  assert.equal(callsOf("query")[0].headers.tokenid, TOKEN_2);
});

test("🔒 checkChannels — กดรัวไม่ทะลุ (จำต่อ บัญชี×กระเป๋า) · หมดอายุแล้วถามใหม่", async () => {
  reset({ query: (body) => (body.tran_type === "5" ? QUERY_CHANNEL_CLOSED : QUERY_CHANNEL_OPEN) });
  const first = await checkChannels({ config: CONFIG, channels: spec.channels });
  assert.equal(callsOf("query").length, 9);
  assert.equal(callsOf("auth").length, 1);
  const second = await checkChannels({ config: CONFIG, channels: spec.channels });
  assert.equal(callsOf("query").length, 9);
  assert.equal(callsOf("auth").length, 1);
  assert.ok(second.data.results.every((x) => x.cached === true));
  assert.deepEqual(second.data.results.map((x) => x.open), first.data.results.map((x) => x.open));
  ntt._setEnv({ NTT_CHANNEL_CHECK_COOLDOWN_MS: "1" });
  await sleep(6);
  await checkChannels({ config: CONFIG, channels: [chThaiQr] });
  assert.equal(callsOf("query").length, 10);
});

test("checkChannels — ถามไม่สำเร็จ = open:null ไม่จำ · auth ล้ม = ล้มทั้งรอบ · input ผิด = ปัดก่อนแตะเน็ต", async () => {
  reset({ query: () => ({ __throw: Object.assign(new Error("boom"), { code: "ENOTFOUND" }) }) });
  const r = await checkChannels({ config: CONFIG, channels: [chThaiQr] });
  assert.equal(r.data.results[0].open, null);
  assert.equal(r.data.results[0].reason, "ntt_network_error");
  ROUTES.query = () => QUERY_CHANNEL_OPEN;
  assert.equal((await checkChannels({ config: CONFIG, channels: [chThaiQr] })).data.results[0].open, true);
  assert.equal(callsOf("query").length, 2);

  reset({ auth: () => authFail, query: () => QUERY_CHANNEL_OPEN });
  assert.equal((await checkChannels({ config: CONFIG, channels: [chThaiQr] })).error.code, "auth_failed");
  assert.equal(callsOf("query").length, 0);

  reset({});
  assert.equal((await checkChannels({ config: CONFIG, channels: [] })).error.code, "bad_input");
  assert.equal((await checkChannels({ config: CONFIG, channels: null })).error.code, "bad_input");
  assert.equal((await checkChannels({ config: CONFIG, channels: [{ channelId: "x" }] })).error.code, "bad_channel");
  assert.equal((await checkChannels({ config: {}, channels: [chThaiQr] })).error.code, "config_missing");
  assert.equal(CALLS.length, 0);
});

test("🔒 checkChannels log — 1 บรรทัด/กระเป๋าที่ถามจริง · token ถูกตัด · TID/hash/plaintext ถูก mask · ≤500", async () => {
  reset({
    query: () => S({ result: false, message: "Fail blank status", trade_state: "NOT_FOUND", tid: TID, token: "LEAKED-TOKEN-XYZ", echo: PW_PLAIN, extra: { password: PW_HASH, nested_tokenid: "LEAK2" }, junk: "x".repeat(2000) }),
  });
  await checkChannels({ config: CONFIG, channels: [chThaiQr] });
  const l = LOGS.filter((x) => x.msg === "function:pos/gateway/providers/ntt/checkChannels:wallet");
  assert.equal(l.length, 1);
  const raw = l[0].data.raw;
  for (const s of ["LEAKED-TOKEN-XYZ", "LEAK2", PW_HASH, PW_PLAIN, TID, TOKEN_1]) assert.equal(raw.includes(s), false, s);
  assert.ok(raw.includes("NOT_FOUND"));
  assert.equal(raw.length, 500);
  assert.equal(JSON.stringify(LOGS).includes(TOKEN_1), false);
  await checkChannels({ config: CONFIG, channels: [chThaiQr] });
  assert.equal(LOGS.length, 1, "cache hit ไม่ log ซ้ำ");
});

// ═══ 14. parseNotify (webhook helper · pure) ═════════════════════════════════════
// payload ตามสเปก §3 Notification — ทุกช่องเป็นแค่สัญญาณ (ไม่มีลายเซ็น)
const notifyBody = (over = {}) => ({
  ref: "88885555166563640244", buyer: "2088732128021134", paidby: "T",
  terminal_id: "19912719", transaction_id: "2024042522001421131414819772",
  tran_amount: 1.0, tran_date: "20240425", tran_time: "1603", transaction_status: "SALE",
  merchantId: "88885555", company_id: "001", out_trade_no: "88885555240425160250", ...over,
});

test("parseNotify — JSON object ตามสเปก → outTradeNo = providerRef · state/amount เป็นค่าบอกใบ้ · raw ครบ", () => {
  const body = notifyBody();
  const r = parseNotify(body);
  assert.deepEqual(r, { ok: true, outTradeNo: "88885555240425160250", providerRef: "88885555240425160250", state: "paid", amount: 1, raw: body });
  assert.equal(CALLS.length, 0, "pure — ไม่แตะเน็ต");
});

test("parseNotify — VOID = closed · สถานะไม่รู้จัก = ไม่มี state · tran_amount เพี้ยน = ไม่มี amount", () => {
  assert.equal(parseNotify(notifyBody({ transaction_status: "VOID" })).state, "closed");
  const r = parseNotify(notifyBody({ transaction_status: "WHAT", tran_amount: "abc" }));
  assert.equal(r.ok, true);
  assert.equal("state" in r, false);
  assert.equal("amount" in r, false);
  assert.equal("amount" in parseNotify(notifyBody({ tran_amount: "" })), false);
  assert.equal(parseNotify(notifyBody({ tran_amount: "25.50" })).amount, 25.5);
});

test("parseNotify — รับ outTradeNo (camel) · ตัวเลข · trim · string JSON · form-encoded · Buffer", () => {
  assert.equal(parseNotify({ out_trade_no: " 123 " }).outTradeNo, "123");
  assert.equal(parseNotify({ outTradeNo: 456 }).outTradeNo, "456");
  assert.equal(parseNotify(JSON.stringify(notifyBody())).outTradeNo, "88885555240425160250");
  const form = "out_trade_no=88885555240425160250&transaction_status=SALE&tran_amount=1.00";
  const f = parseNotify(form);
  assert.equal(f.outTradeNo, "88885555240425160250");
  assert.equal(f.state, "paid");
  assert.equal(f.amount, 1);
  assert.equal(parseNotify(Buffer.from(JSON.stringify(notifyBody()))).providerRef, "88885555240425160250");
});

test("parseNotify — ไม่มี out_trade_no = notify_missing_out_trade_no · อ่านไม่ออก = notify_bad_body", () => {
  assert.deepEqual(parseNotify({ ref: "x" }).error.code, "notify_missing_out_trade_no");
  assert.equal(parseNotify({ out_trade_no: "  " }).error.code, "notify_missing_out_trade_no");
  assert.equal(parseNotify({ out_trade_no: null }).error.code, "notify_missing_out_trade_no");
  for (const bad of [null, undefined, "", "not json", "{broken", 42, [], ["a"]]) {
    const r = parseNotify(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.error.code, "notify_bad_body", JSON.stringify(bad));
    assert.equal(typeof r.error.message, "string");
  }
});
