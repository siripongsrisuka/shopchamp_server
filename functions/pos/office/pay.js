// pos/office/pay — หน้า "ชำระเงิน" ของ shopchampoffice: ใบรอตรวจ + รายการจ่ายอัตโนมัติ · ตรวจกับผู้ให้บริการ · อนุมัติมือ · ยกเลิก (DEV-0003 U4)
//
// แทน: จอ approve ของ care (`shopchamp_care/src/screens/Approve{Software,Hardware,Image,Stock}Screen.js` · เขียนฐานจากเบราว์เซอร์)
// สัญญา (ร่าง รอ Pack เซ็น): shopchamp-center/api/office.payList.yaml · office.payRecheck.yaml · office.orderApprove.yaml · office.orderCancel.yaml
// ตัวสร้างสัญญา: lanes/dev/source/office-pay-cases.js
//
// สิทธิ์ (ตัดสินที่ server จาก watcher/roster ทุกคำขอ · S.gate):
//   payList      watcher + root (ดูอย่างเดียว) · คืน canAct = root
//   payRecheck   root · ไม่ต้อง passkey — ทำสิ่งเดียวกับที่ตัวกวาดอัตโนมัติ (U3) ทำเองโดยไม่มีคน: ถามผู้ให้บริการ แล้วเปิดของเมื่อเงินเข้าครบเท่านั้น
//   orderApprove root · เปิดของจากสลิปด้วยตา = fulfill via 'manual' (ไม่ใช้ passkey แล้ว · Pack ถอด 2026-11-11)
//   orderCancel  root · เฉพาะใบ status 'order' · เงินเข้าแล้ว (companyPay paid/problem) = ปัด
//
// ของที่อ่าน:
//   ใบ 4 ชนิด packageOrder hardwareOrder imageOrder stockOrder ที่ status 'order' (แบบ care · where status == 'order' · ไม่ orderBy = ไม่ต้องมี index ผสม)
//     เรียงใหม่สุดในหน่วยความจำ · อ่านไม่เกิน READ_CAP ต่อชนิด (ใบรอตรวจมีหลักหน่วย · census §3)
//   companyPay/{kind}-{orderUUID} (ของ U2 · pos/company/_payCheck.js › payDocId · อ่านผ่าน payView ที่เดียว): status 'problem' / 'request' ทั้งหมด (ไม่เกิน READ_CAP)
//     + ที่ขยับใน PAID_WINDOW_DAYS วันล่าสุด (updatedAt ≥ · เรียงลง · ช่องเดียว ไม่ต้อง index ผสม) แล้วคัด status 'paid' / 'expired'
//   ใบจ่ายที่ใบสั่งซื้อไม่อยู่ในกองรอตรวจ = อ่านใบทีละ doc เพื่อรู้ว่าได้ของแล้วหรือยัง
//
// แถว: {key, kind, orderUUID, orderNumber, shopId, shopName, buyer, amount, amountSatang, slipUrl, channel 'slip'|'posxpay',
//        payMethod 'qr'|'slip' (ช่อง payMethod ของใบ · U2b schema 0.1.23 · ใบเดิมไม่มีช่อง = slip),
//        payState 'slip'|'waiting'|'paid'|'problem'|อื่นตามที่ U2 เขียน, goodsState 'waiting'|'delivered'|'cancelled'|'missing'|'unknown',
//        orderStatus, payStatus, problem, at, detail}
//   ใบ QR ที่ยังไม่มีสลิปและยังไม่มี companyPay (ร้านกด QR แล้วยังไม่ขอ/ปิดแอปก่อน) = payState 'waiting' channel 'posxpay' slipUrl null
//     ⇒ ไม่นับเป็น "สลิปรออนุมัติ" · root ยังอนุมัติมือได้ (จอต้องมีป้ายว่าไม่มีสลิป · _payView.js › noSlipText)
//   problem = companyPay 'problem' หรือ เงินเข้าแล้ว (paid) แต่ใบยังไม่เปิดของ ⇒ จอดันขึ้นบนสุด
//
// ตัวต่อของจออื่น (ผ่าน deps ได้ทุกตัว · เทส/harness ฉีดตัวปลอม):
//   checkCompanyPay  ไม่ส่ง = require('../company/_payCheck').checkCompanyPay({kind, orderUUID, now, env}) → {state:'waiting'|'paid'|'closed'|'expired'|'problem', ...}
//   fulfill          ไม่ส่ง = require('../company/_fulfill').fulfill (ตัวเปิดของตัวเดียว · U1)
//   push             ตัวส่งของ _shared/push/notify.js
//   env              ไม่ส่ง = process.env (ส่งต่อให้ checkCompanyPay เท่านั้น)
// audit: officeAudit ทุกการกด (สำเร็จ และถูกปัดหลังแตะนิ้วแล้ว) · action pay.recheck · order.approve · order.cancel
// ❌ ไม่แตะ pos/company/* (อ่าน KINDS อย่างเดียว) · ❌ ไม่แตะ route
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, internalError } = require("../_shared/respond");
const { readNow, depOr } = require("../_shared/deps");
const { notify } = require("../_shared/push/notify");
const { KINDS } = require("../company/_fulfill");
const S = require("./_officeStore");
const C = require("./_officeCore");

const PAY = "companyPay";
const READ_CAP = 200;
const LIMIT_DEFAULT = 100;
const LIMIT_MAX = 200;
const PAID_WINDOW_DAYS = 7;

/** ตารางชนิด = KINDS ของตัวเปิดของ (_fulfill.js · อ่านอย่างเดียว) ⇒ ชื่อ collection · ช่องยอด · สถานะ "เปิดของแล้ว" มีที่เดียว */
const KIND_SPEC = KINDS;
const KIND_NAMES = Object.freeze(Object.keys(KIND_SPEC));
const COLLECTION_KIND = Object.freeze(Object.fromEntries(KIND_NAMES.map((k) => [KIND_SPEC[k].collection, k])));
const PAY_LISTED = Object.freeze(["problem", "request", "paid", "expired"]);
/** doc id ของใบจ่าย = `<kind>-<orderUUID>` (ตรง _payCheck.js › payDocId) */
const payDocId = (kind, orderUUID) => `${kind}-${orderUUID}`;

/** ข้อความแจ้งร้านตอนยกเลิก (ตรง care ทีละชนิด) */
const CANCEL_PUSH = Object.freeze({
  package: { heading: "ยกเลิกรายการสั่งซื้อ!", content: "คำสั่งซื้อไม่ถูกต้อง" }, // ApproveSoftwareScreen.js:129-133
  hardware: { heading: "ยกเลิกรายการสั่งซื้อ!", content: "คำสั่งซื้อไม่ถูกต้อง" }, // ApproveHardwareScreen.js:65-69
  image: { heading: "ยกเลิกการซื้อพื้นที่เก็บไฟล์", content: "หลักฐานการชำระเงินไม่ถูกต้อง" }, // ApproveImageScreen.js:75-79
  stock: { heading: "ยกเลิกการเพิ่มสต๊อก", content: "หลักฐานการชำระเงินไม่ถูกต้อง" }, // ApproveStockScreen.js:87-91
});

const CANCEL_REFUSE_TEXT = Object.freeze({
  order_not_found: "ไม่พบใบสั่งซื้อ",
  order_not_cancellable: "ยกเลิกได้เฉพาะใบที่รอตรวจสอบ (สถานะเปลี่ยนระหว่างแตะนิ้ว)",
  pay_received: "ใบนี้มีเงินเข้าแล้ว ยกเลิกไม่ได้ · กดตรวจกับผู้ให้บริการแทน",
});

const str = (v) => (typeof v === "string" ? v : "");
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const validDocId = (v) => typeof v === "string" && v !== "" && v.length <= 1500 && !v.includes("/") && v !== "." && v !== "..";
/** ยอด → สตางค์ · ไม่มี/อ่านไม่ออก = null (toSatang(undefined) = 0 ⇒ จอจะเห็นใบ ฿0 ทั้งที่ยอดหาย) */
const sat = (v) => {
  if (typeof v === "number" ? !Number.isFinite(v) : !(typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))) return null;
  const s = logic.toSatang(v);
  return Number.isSafeInteger(s) ? s : null;
};

// ── ตรวจรูปคำขอ (strict · field เกิน = 400) ─────────────────────────────────
function bad(message) { S.refuse(400, "invalid_request", message); }
function bodyOf(req) {
  const b = req ? req.body : undefined;
  if (b === undefined || b === null) return {};
  if (!isObj(b)) bad("คำขอต้องเป็น object");
  return b;
}
function onlyKeys(b, allowed) {
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length) bad(`ไม่รับช่อง: ${extra.join(", ")}`);
}
function kindOf(v) {
  if (!KIND_NAMES.includes(v)) bad("kind ต้องเป็น package | hardware | image | stock");
  return v;
}
function uuidOf(v) {
  if (!validDocId(v)) bad("orderUUID ต้องเป็นรหัสใบที่ใช้เป็น doc id ได้");
  return v;
}

function parseList(b) {
  onlyKeys(b, ["kinds", "limit"]);
  let kinds = KIND_NAMES.slice();
  if (b.kinds !== undefined) {
    if (!Array.isArray(b.kinds) || !b.kinds.length || b.kinds.length > KIND_NAMES.length) bad("kinds ต้องเป็นรายการชนิด 1-4 ตัว");
    kinds = [...new Set(b.kinds.map(kindOf))];
  }
  let limit = LIMIT_DEFAULT;
  if (b.limit !== undefined) {
    if (!Number.isInteger(b.limit) || b.limit < 1 || b.limit > LIMIT_MAX) bad(`limit ต้องเป็นจำนวนเต็ม 1-${LIMIT_MAX}`);
    limit = b.limit;
  }
  return { kinds, limit };
}
function parseTarget(b, keys) {
  onlyKeys(b, keys);
  return { kind: kindOf(b.kind), orderUUID: uuidOf(b.orderUUID) };
}

// ── รูปแถว ─────────────────────────────────────────────────────────────────

/** ใบจ่าย (companyPay) → ส่วนที่จอใช้ · รูป doc ของ U2 ยังไม่นิ่ง ⇒ อ่านเผื่อชื่อช่อง แล้วรวมที่นี่ที่เดียว */
function payView(id, d) {
  const data = isObj(d) ? d : {};
  const kind = KIND_NAMES.includes(data.kind) ? data.kind : COLLECTION_KIND[str(data.collection)] || null;
  const amountSatang = Number.isSafeInteger(data.amountSatang) ? data.amountSatang : sat(data.amount);
  const fromId = kind && id.startsWith(`${kind}-`) ? id.slice(kind.length + 1) : "";
  const problem = isObj(data.problem) ? str(data.problem.code) || str(data.problem.message) : str(data.problem);
  return {
    id,
    kind,
    orderUUID: str(data.orderUUID) || fromId,
    status: str(data.status) || str(data.state),
    provider: str(data.provider) || "posxpay",
    providerRef: str(data.providerRef) || null,
    amountSatang: Number.isSafeInteger(amountSatang) ? amountSatang : null,
    paidSatang: Number.isSafeInteger(data.paidSatang) ? data.paidSatang : null,
    shopId: str(data.shopId) || null,
    problem: problem || null,
    at: C.isoOf(data.updatedAt) || C.isoOf(data.paidAt) || C.isoOf(data.createdAt),
    createdAt: C.isoOf(data.createdAt),
  };
}

function goodsStateOf(kind, status) {
  if (status === null) return "missing";
  if (status === "order") return "waiting";
  if (status === "cancel") return "cancelled";
  if (KIND_SPEC[kind].opened.includes(status)) return "delivered";
  return "unknown";
}

/** รายละเอียดที่จอใช้ประกอบการตัดสิน (ไม่ส่งที่อยู่/ข้อมูลใบกำกับเต็ม) */
function detailOf(kind, o) {
  if (kind === "package") return { packageId: Array.isArray(o.packageId) ? o.packageId.map(String) : [], vat: o.vat === true };
  if (kind === "image") return { qty: Number.isFinite(o.qty) ? o.qty : null };
  if (kind === "stock") return { qty: Number.isFinite(o.qty) ? o.qty : null, packId: o.id === undefined ? null : o.id };
  const product = Array.isArray(o.product) ? o.product : [];
  return {
    items: product.slice(0, 20).map((p) => ({ name: str(p && (p.name || p.title)), qty: p && Number.isFinite(p.qty) ? p.qty : null })),
    vat: o.vat === true,
  };
}

function rowOf({ kind, orderUUID, order, pay }) {
  const spec = KIND_SPEC[kind];
  const o = isObj(order) ? order : null;
  const orderStatus = o ? str(o.status) : null;
  const amountSatang = o ? sat(o[spec.amountField]) : pay ? pay.amountSatang : null;
  const goodsState = goodsStateOf(kind, orderStatus);
  const payStatus = pay ? pay.status : null;
  const slipUrl = o && str(o.imageId) ? o.imageId : null;
  // ใบที่ร้านเลือกจ่าย QR (U2b) · แนบสลิปทีหลัง server เขียน payMethod 'slip' ให้ ⇒ กลับมาเป็นแถวสลิป
  const qrNoSlip = !!o && str(o.payMethod) === "qr" && !slipUrl;
  const payState = pay ? (payStatus === "request" ? "waiting" : payStatus || "unknown") : qrNoSlip ? "waiting" : "slip";
  const problem = payStatus === "problem" || (payStatus === "paid" && goodsState !== "delivered");
  return {
    key: `${kind}:${orderUUID}`,
    kind,
    orderUUID,
    orderNumber: o ? str(o.orderNumber) || null : null,
    shopId: o ? str(o.shopId) || null : pay ? pay.shopId : null,
    shopName: o ? str(o.shopName) : "",
    buyer: o ? { name: str(o.profileName), tel: str(o.tel) } : null,
    amountSatang: Number.isSafeInteger(amountSatang) ? amountSatang : null,
    amount: Number.isSafeInteger(amountSatang) ? amountSatang / 100 : null,
    slipUrl,
    channel: pay ? pay.provider : qrNoSlip ? "posxpay" : "slip",
    payMethod: o ? (str(o.payMethod) === "qr" ? "qr" : "slip") : null,
    payState,
    goodsState,
    orderStatus,
    payStatus,
    payProblem: pay ? pay.problem : null,
    providerRef: pay ? pay.providerRef : null,
    paidSatang: pay ? pay.paidSatang : null,
    problem,
    at: (o && C.isoOf(o.timestamp)) || (pay && pay.at) || null,
    payAt: pay ? pay.at : null,
    detail: o ? detailOf(kind, o) : null,
  };
}

/** เรียง: problem บนสุด → ใหม่สุดก่อน · เวลาอ่านไม่ได้ไว้ท้าย */
function sortRows(rows) {
  const t = (r) => (r.at ? Date.parse(r.at) : -Infinity);
  return rows.sort((a, b) => (a.problem === b.problem ? t(b) - t(a) : a.problem ? -1 : 1));
}

// ── อ่าน ────────────────────────────────────────────────────────────────────
async function readPending(kind) {
  const snap = await db.collection(KIND_SPEC[kind].collection).where("status", "==", "order").limit(READ_CAP).get();
  return (snap.docs || []).map((d) => ({ id: d.id, data: d.data() || {} }));
}

async function readPays(now) {
  const coll = db.collection(PAY);
  const since = new Date(now.getTime() - PAID_WINDOW_DAYS * 86400000);
  const [problem, request, recent] = await Promise.all([
    coll.where("status", "==", "problem").limit(READ_CAP).get(),
    coll.where("status", "==", "request").limit(READ_CAP).get(),
    coll.where("updatedAt", ">=", since).orderBy("updatedAt", "desc").limit(READ_CAP).get(),
  ]);
  const out = new Map();
  for (const snap of [problem, request, recent]) {
    for (const d of snap.docs || []) {
      const v = payView(d.id, d.data());
      if (PAY_LISTED.includes(v.status) && !out.has(v.id)) out.set(v.id, v);
    }
  }
  return [...out.values()];
}

async function buildList({ kinds, limit, now }) {
  const pending = await Promise.all(kinds.map(async (kind) => ({ kind, docs: await readPending(kind) })));
  const pays = await readPays(now);
  const payByKey = new Map(pays.filter((p) => p.kind && p.orderUUID).map((p) => [`${p.kind}:${p.orderUUID}`, p]));
  const rows = new Map();
  for (const { kind, docs } of pending) {
    for (const d of docs) {
      const key = `${kind}:${d.id}`;
      rows.set(key, rowOf({ kind, orderUUID: d.id, order: d.data, pay: payByKey.get(key) || null }));
    }
  }
  // ใบจ่ายที่ใบสั่งซื้อไม่อยู่ในกองรอตรวจ (เปิดของแล้ว / ยกเลิก / หาไม่เจอ) = อ่านใบทีละ doc
  const orphans = pays.filter((p) => p.kind && kinds.includes(p.kind) && !rows.has(`${p.kind}:${p.orderUUID}`) && validDocId(p.orderUUID));
  const unknownKind = pays.filter((p) => !p.kind || !p.orderUUID).length;
  const snaps = await Promise.all(orphans.map((p) => db.collection(KIND_SPEC[p.kind].collection).doc(p.orderUUID).get()));
  orphans.forEach((p, i) => {
    const s = snaps[i];
    rows.set(`${p.kind}:${p.orderUUID}`, rowOf({ kind: p.kind, orderUUID: p.orderUUID, order: s && s.exists ? s.data() || {} : null, pay: p }));
  });
  const all = sortRows([...rows.values()]);
  const counts = { total: all.length, problem: 0, slip: 0, waiting: 0, paid: 0, byKind: Object.fromEntries(KIND_NAMES.map((k) => [k, 0])) };
  for (const r of all) {
    if (r.problem) counts.problem += 1;
    if (r.payState === "slip") counts.slip += 1;
    if (r.payState === "waiting") counts.waiting += 1;
    if (r.payState === "paid") counts.paid += 1;
    counts.byKind[r.kind] += 1;
  }
  // ตัดตาม limit แต่ problem ไม่ถูกตัดทิ้งเด็ดขาด (เรียงไว้บนสุดแล้ว)
  const keep = Math.max(limit, counts.problem);
  return { rows: all.slice(0, keep), counts, truncated: all.length > keep, unknownKindPays: unknownKind };
}

// ── ของร่วมของการกด ────────────────────────────────────────────────────────
function wrap(run) {
  return async function handler(req, res) {
    try {
      return await run(req, res);
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      if (e && isObj(e.deny) && e.deny.ok === false && Number.isInteger(e.deny.status)) return sendDeny(res, e.deny); // Refusal ของ pos/company
      return internalError(res, e);
    }
  };
}

/** ชื่อผู้กด: ชื่อในทะเบียน → อีเมล → uid (ลง approveName แบบ care) */
function actorOf(g) {
  const people = g.roster && Array.isArray(g.roster.people) ? g.roster.people : [];
  const p = people.find((x) => x && x.uid === g.uid);
  const name = (p && str(p.name).trim()) || g.email || g.uid;
  return { uid: g.uid, name, email: g.email };
}

/** อ่านใบก่อนแตะนิ้ว (ไม่ให้เสียนิ้วกับใบที่ทำต่อไม่ได้) · ตัวจริงตรวจซ้ำใน transaction */
async function precheckOrder(kind, orderUUID) {
  const snap = await db.collection(KIND_SPEC[kind].collection).doc(orderUUID).get();
  if (!snap || !snap.exists) S.refuse(404, "order_not_found", "ไม่พบใบสั่งซื้อ", { kind, orderUUID });
  const order = snap.data() || {};
  return { order, status: str(order.status) };
}

const pushesOf = (p) => (Array.isArray(p) ? p : p ? [p] : []).filter(isObj);

async function audit(now, actor, action, result, extra) {
  await S.auditOutside({ action, result, actor, now, extra });
}

// ── handler ────────────────────────────────────────────────────────────────

function payList(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const input = parseList(bodyOf(req));
    const now = await readNow(deps);
    const g = await S.gate(req, "staff");
    const out = await buildList({ ...input, now });
    return ok(res, { ...out, canAct: g.role === "root", kinds: input.kinds, paidWindowDays: PAID_WINDOW_DAYS, at: now.toISOString() });
  });
}

function payRecheck(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const t = parseTarget(bodyOf(req), ["kind", "orderUUID"]);
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const actor = actorOf(g);
    const check = depOr(deps, "checkCompanyPay", (a) => require("../company/_payCheck").checkCompanyPay(a));
    const env = deps && isObj(deps.env) ? deps.env : process.env;
    let r;
    try {
      r = await check({ kind: t.kind, orderUUID: t.orderUUID, now, env });
    } catch (e) {
      const d = e && isObj(e.deny) ? e.deny : null;
      await audit(now, actor, "pay.recheck", "rejected", { kind: t.kind, orderUUID: t.orderUUID, rejectCode: d ? d.error : "internal_error" });
      throw e;
    }
    if (!isObj(r) || typeof r.state !== "string" || !r.state) throw new Error("checkCompanyPay คืนค่าผิดรูป");
    // _payCheck คืน {state, fulfilled:{duplicate,status}?, push?} · push = null เมื่อ duplicate (ส่งเฉพาะครั้งที่เปิดของจริง)
    const fulfillOut = isObj(r.fulfilled) ? r.fulfilled : null;
    const duplicate = fulfillOut ? fulfillOut.duplicate === true : false;
    const push = pushesOf(r.push);
    if (!duplicate && push.length) await notify(deps, push);
    await audit(now, actor, "pay.recheck", "ok", { kind: t.kind, orderUUID: t.orderUUID, state: r.state });
    return ok(res, {
      kind: t.kind,
      orderUUID: t.orderUUID,
      state: r.state,
      opened: r.state === "paid" && !!(fulfillOut || r.opened === true),
      duplicate,
      transient: r.transient === true,
      reason: typeof r.reason === "string" ? r.reason : undefined,
    });
  });
}

function orderApprove(deps) {
  return wrap(async (req, res) => {
    const caller = S.callerOf(req);
    const b = bodyOf(req);
    const t = parseTarget(b, ["kind", "orderUUID"]);
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const actor = actorOf(g);

    const pre = await precheckOrder(t.kind, t.orderUUID);
    if (pre.status === "cancel") S.refuse(409, "order_cancelled", "ใบนี้ถูกยกเลิกแล้ว", t);
    if (KIND_SPEC[t.kind].opened.includes(pre.status)) S.refuse(409, "order_already_opened", "ใบนี้เปิดของไปแล้ว", { ...t, status: pre.status });
    if (pre.status !== "order") S.refuse(409, "order_status_unexpected", "สถานะใบนี้ไม่ใช่รอตรวจสอบ", { ...t, status: pre.status });

    const run = depOr(deps, "fulfill", (a) => require("../company/_fulfill").fulfill(a));
    let r;
    try {
      r = await run({ kind: t.kind, orderUUID: t.orderUUID, via: "manual", actor: { uid: actor.uid, name: actor.name }, now });
    } catch (e) {
      const d = e && isObj(e.deny) ? e.deny : null;
      await audit(now, actor, "order.approve", "rejected", { ...t, rejectCode: d ? d.error : "internal_error" });
      throw e;
    }
    if (!isObj(r)) throw new Error("fulfill คืนค่าผิดรูป");
    if (!r.duplicate) await notify(deps, pushesOf(r.push));
    await audit(now, actor, "order.approve", "ok", { ...t, duplicate: r.duplicate === true, status: str(r.status) });
    return ok(res, {
      kind: t.kind,
      orderUUID: t.orderUUID,
      duplicate: r.duplicate === true,
      status: str(r.status),
      effects: isObj(r.effects) ? r.effects : null,
      approveName: actor.name,
    });
  });
}

function orderCancel(deps) {
  return wrap(async (req, res) => {
    const caller = S.callerOf(req);
    const b = bodyOf(req);
    const t = parseTarget(b, ["kind", "orderUUID", "silent"]);
    if (b.silent !== undefined && typeof b.silent !== "boolean") bad("silent ต้องเป็น true/false");
    const silent = b.silent === true;
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const actor = actorOf(g);
    const spec = KIND_SPEC[t.kind];

    const pre = await precheckOrder(t.kind, t.orderUUID);
    if (pre.status !== "order") S.refuse(409, "order_not_cancellable", "ยกเลิกได้เฉพาะใบที่รอตรวจสอบ", { ...t, status: pre.status });
    const payRef = db.collection(PAY).doc(payDocId(t.kind, t.orderUUID));
    const paySnap0 = await payRef.get();
    if (paySnap0 && paySnap0.exists && ["paid", "problem"].includes(payView(payRef.id, paySnap0.data()).status)) {
      S.refuse(409, "pay_received", "ใบนี้มีเงินเข้าแล้ว ยกเลิกไม่ได้ · กดตรวจกับผู้ให้บริการแทน", t);
    }

    const orderRef = db.collection(spec.collection).doc(t.orderUUID);
    const out = await db.runTransaction(async (tx) => {
      const [snap, paySnap] = await Promise.all([tx.get(orderRef), tx.get(payRef)]);
      if (!snap || !snap.exists) return { code: "order_not_found", status: 404 };
      const order = snap.data() || {};
      if (str(order.status) !== "order") return { code: "order_not_cancellable", status: 409, orderStatus: str(order.status) };
      if (paySnap && paySnap.exists && ["paid", "problem"].includes(payView(payRef.id, paySnap.data()).status)) return { code: "pay_received", status: 409 };
      tx.update(orderRef, { status: "cancel", cancelId: actor.uid, cancelName: actor.name, cancelledAt: now, cancelVia: "office" });
      tx.create(S.auditRef(now, caller.uid, "order.cancel", t.orderUUID), S.auditEntry({
        action: "order.cancel", result: "ok", actor, now, extra: { ...t, silent },
      }));
      return { code: null, profileId: str(order.profileId) };
    });
    if (out.code) {
      await audit(now, actor, "order.cancel", "rejected", { ...t, rejectCode: out.code });
      S.refuse(out.status, out.code, CANCEL_REFUSE_TEXT[out.code], { ...t, ...(out.orderStatus !== undefined ? { status: out.orderStatus } : {}) });
    }
    if (!silent && out.profileId) await notify(deps, [{ to: { kind: "people", ids: [out.profileId] }, ...CANCEL_PUSH[t.kind] }]);
    return ok(res, { kind: t.kind, orderUUID: t.orderUUID, status: "cancel", notified: !silent && !!out.profileId });
  });
}

module.exports = {
  payList, payRecheck, orderApprove, orderCancel,
  // ส่วนที่เทสเจาะได้
  KIND_SPEC, CANCEL_PUSH, payView, rowOf, sortRows, buildList, actorOf, READ_CAP, PAID_WINDOW_DAYS,
};
