// pos/scango/merchantRelay.js — เว็บร้าน ScanGo ส่งต่อมาทำแทนคนในร้าน (auth 'partner' · รอบ 4 Pack เคาะ 2026-11-12)
//
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/scango/merchantRelay.js` › asPlatformOwner + relay ต่อ op
//   ผู้เรียก = เซิร์ฟเวอร์ ScanGo (กุญแจร่วม · _partnerAuth.js) ในนามคนที่เข้าเว็บร้านแล้ว (connector shopchamp › merchantRelay)
//   ท่าเดียวกับต้นแบบ: **ใช้ handler เดิมไม่แก้สักบรรทัด** — ตั้ง req.shopAccess + req.body.shopId แบบที่ requireShopAccess ตั้งให้แอป
//     แล้วเรียก `shop/productSearch` / `shop/productsSet` ตัวจริง ⇒ ด่านสิทธิ์ '111' · เพดาน 1000 · ตรวจสินค้ามีจริง = ของเดิมทุกไบต์
//   🔒 actor บังคับ: {uid:'mo:…'|'md:…'|'ms:…'|'admin:…', personRef?, name?} ไม่มี/uid ผิดรูป = 400 actor_required (ไม่ทำแทนใครแบบไม่มีชื่อ · รูปเดียวกับต้นแบบ)
//   🔒 ปิดรายร้าน: shop.scango.merchantRelay === false = 403 merchant_relay_disabled
//   🔒 log ทุกคำขอ 1 บรรทัด {message:'scango.merchantRelay', op, shopId, actor, personRef6, result}
//   สิทธิ์ = **ทำแทนเจ้าของทุกคำขอ** แบบต้นแบบ `asPlatformOwner` (Pack เคาะ C2 2026-11-12 · เลิกตรวจสิทธิ์คนกดรายคน)
//     ScanGo ปล่อยผ่านด่านสิทธิ์รายแท็บของเว็บร้านมาแล้วก่อนถึงเรา · access = {role:'owner', rights:[], uid: actor.personRef || 'scango:<actor.uid>'}
//     handler ของบ้านนี้ตรวจสมาชิกซ้ำใน transaction (member/_gate.readShopForWrite) ⇒ ตั้ง `byAdmin:true` ให้ข้ามด่านนั้น (ทางเดียวกับทีมงาน root)
//     ⚠️ ผล: กุญแจแพลตฟอร์ม + actor = เขียนค่าตั้ง ScanGo ของร้านได้ทุกร้าน ⇒ ปิดรายร้าน `shop.scango.merchantRelay === false` + log ทุกคำขอ (ท่าเดียวกับต้นแบบ R8)
//
// POST /pos/scango/merchant/products/list {externalId, q?, cursor?, actor}  (scango.merchantProductsList)
//   → 200 {items:[{productId, name, price, imageUrl?, category?, selected}], selectedCount, max:1000, nextCursor}
//   แกน = shop/productSearch (หน้าละ ≤50 · ⚠️ ได้น้อยกว่า 50 แต่ nextCursor ไม่ null ได้ ⇒ เว็บเรียกต่อจน null)
//   imageUrl = stock.imageId (เป็น URL อยู่แล้ว · ว่าง = ไม่ใส่ช่อง) · category = ชื่อหมวดชั้นลึกสุดในเส้นทางที่เจอใน shop.smartCategory (ไม่เจอ = ไม่ใส่)
// POST /pos/scango/merchant/products/set {externalId, productIds, actor}  (scango.merchantProductsSet)
//   → 200 {selectedCount} · แกน = shop/productsSet (แทนทั้งรายการ · ≤1000 · มีจริงในร้าน · ตัดซ้ำ)
// POST /pos/scango/merchant/ordering {externalId, actor, enabled?, minOrder?, deliveryFeeModel?, maxKm?}  (scango.merchantOrdering · รอบ 5)
//   ยกจากต้นแบบ `merchantRelay.js › orderingRelayBody` + `ordering.js › parseBody/ordering` (เปิด/ปิดรับ · ขั้นต่ำ · สูตรค่าส่งแบบช่วง)
//   ช่องอื่น = 400 field_not_relayed details.errors[{field,message}] (ไม่ทิ้งเงียบ) · สูตรผิด = 400 bad_delivery_model details.errors รายช่อง
//   maxKm = ตัวยืนยัน (ไม่เก็บแยก · ไกลสุดคิดจากขอบช่วงสุดท้าย) · ส่ง maxKm ไม่ส่งสูตร / ไม่ตรง = 400 bad_delivery_model field maxKm
//   ไม่มีช่องที่ตั้งเลย = 400 invalid_request · ด่านเจ้าของ (403 owner_only · รหัสต้นแบบ) คงไว้ในแกน แต่ทาง relay ผ่านเสมอ (ทำแทนเจ้าของ · C2)
//   enabled:true แต่ยังไม่เลือกสินค้า = 409 scango_not_ready {missing:['products']} (ต้นแบบไม่มีด่านนี้ · บ้านนี้คงไว้เพราะร้านปลีกเลือกทีละตัว)
//   เขียน `shop.scango.<enabled|minOrder|deliveryFeeModel>` (dotted · transaction ตรวจสมาชิกซ้ำ) → **ยิง venue_ordering ให้เสร็จก่อนตอบ**
//   → 200 {ordering:{enabled, minOrder, deliveryFee, deliveryFeeModel, deliveryFeeSource, maxKm}, synced, venue, reason?}
//     synced = ถึง ScanGo แล้ว · venue = คำเดียวกับ settingsSave (sent|queued|skipped|failed) · ยิงไม่ออก = ค่าตั้งบันทึกแล้ว synced:false
// POST /pos/scango/merchant/fee/preview {externalId, actor, deliveryFeeModel, maxKm?, distancesKm?}  (scango.merchantFeePreview · รอบ 5)
//   คิดอย่างเดียว ไม่อ่าน/เขียนค่าตั้ง (ด่าน actor/สมาชิก/merchantRelay เหมือนเส้นอื่น) · `_deliveryFee.feePreview` (ยกจากต้นแบบ)
//   → 200 {valid, errors, maxKm, stepsLeft, examples:[{km, fee, outOfRange, how, edge?}]} · สูตรผิด = 200 valid:false (ไม่ 400 · จอเรียกทุกครั้งที่พิมพ์)
// คำตอบไม่สำเร็จของแกน = ส่งต่อทั้งสถานะและซอง (400 invalid_request · 403 right_required · 409 too_many_products · 409 product_not_found ฯลฯ)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { ok, fail } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { db } = require("../../firebase");
const { sendDeny, internalError } = require("../_shared/respond");
const { isOwner } = require("../_shared/auth");
const { readShopForWrite, Refusal: GateRefusal } = require("../member/_gate");
const C = require("./_core");
const S = require("./shop/_common");
const DF = require("./_deliveryFee");

const ACTOR_UID_RE = /^(mo|md|ms|admin):[^\s]{1,160}$/; // ชุดเดียวกับต้นแบบ (ms: = พนักงานเว็บร้าน ScanGo)
const short6 = (v) => (typeof v === "string" ? v.slice(0, 6) : "");

/** actorOf(raw) → {uid, personRef|null, name|null} · ผิดรูป = 400 actor_required (ท่าเดียวกับต้นแบบ · personRef ไม่บังคับ) */
function actorOf(raw) {
  if (!C.isObj(raw)) C.refuse(400, "actor_required", "ต้องส่ง actor { uid } ของคนที่กดบนเว็บ");
  const uid = C.str(raw.uid);
  if (!ACTOR_UID_RE.test(uid)) C.refuse(400, "actor_required", "actor.uid ต้องขึ้นต้น mo: / md: / ms: / admin:");
  return { uid, personRef: C.str(raw.personRef).slice(0, 128) || null, name: C.str(raw.name).slice(0, 80) || null };
}

/** accessOf(shopId, actor) — ทำแทนเจ้าของ (ต้นแบบ `asPlatformOwner` · Pack เคาะ C2) · byAdmin = ข้ามด่านสมาชิกซ้ำของ handler แกน */
function accessOf(shopId, actor) {
  return { shopId, uid: actor.personRef || `scango:${actor.uid}`, role: "owner", rights: [], byAdmin: true, via: "scango", scangoActor: actor.uid };
}

/** res ปลอมเก็บผลของ handler แกน */
function captureRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

/** ส่งต่อคำตอบไม่สำเร็จของแกน (ซองเดิม) */
function passFail(res, r) {
  const b = C.isObj(r.body) ? r.body : {};
  const { ok: _ok, error, message, ...extra } = b;
  return fail(res, r.code, typeof error === "string" ? error : "internal_error", message, extra);
}

function logOf(deps) {
  const custom = deps && typeof deps.audit === "function" ? deps.audit : null;
  return (line) => {
    const full = { message: "scango.merchantRelay", ...line };
    try {
      if (custom) custom(full);
      else console.log(JSON.stringify({ severity: line.result === "ok" ? "INFO" : "WARNING", ...full }));
    } catch (_) { /* log ล้มไม่ล้มคำตอบ */ }
  };
}

/** categoryNameOf(shop) → (path ids) → ชื่อหมวดชั้นลึกสุดที่เจอ | '' */
function categoryNameOf(shop) {
  const names = new Map();
  for (const lv of Array.isArray(shop && shop.smartCategory) ? shop.smartCategory : []) {
    for (const c of C.isObj(lv) && Array.isArray(lv.value) ? lv.value : []) {
      if (C.isObj(c) && typeof c.id === "string" && typeof c.name === "string" && c.name.trim()) names.set(c.id, c.name.trim());
    }
  }
  return (ids) => {
    for (let i = (ids || []).length - 1; i >= 0; i--) if (names.has(ids[i])) return names.get(ids[i]);
    return "";
  };
}

/**
 * relay(op, keys, core, shape) → factory ของเส้น /scango/merchant/<op>
 *   keys = ช่องที่รับนอกจาก externalId/actor (ช่องเกิน = 400 invalid_request) · core = factory ของ handler แกน
 *   shape(body200, shop) → คำตอบ 200 ของเว็บ
 */
function relay(op, keys, core, shape, opts) {
  const passAll = !!(opts && opts.passAll); // ordering: ช่องเกินให้แกนตัดสินเอง (400 field_not_relayed แบบต้นแบบ)
  return function factory(deps) {
    const log = logOf(deps);
    const coreHandler = core(deps);
    return C.wrap(async (req, res) => {
      const line = { op, shopId: "", actor: "", personRef6: "", result: "" };
      try {
        const b = C.bodyOf(req);
        if (!passAll) C.onlyKeys(b, ["externalId", "actor", ...keys]);
        const shopId = C.idOf(b.externalId, "externalId");
        line.shopId = shopId;
        const actor = actorOf(b.actor);
        line.actor = actor.uid; line.personRef6 = short6(actor.personRef);
        const shop = await C.loadShop(shopId);
        if (C.isObj(shop.scango) && shop.scango.merchantRelay === false) C.refuse(403, "merchant_relay_disabled", "ร้านนี้ปิดการตั้งค่าผ่านเว็บ ScanGo ไว้");
        const access = accessOf(shopId, actor);

        const body = { shopId };
        const pass = passAll ? Object.keys(b).filter((k) => k !== "externalId" && k !== "actor" && k !== "shopId") : keys;
        for (const k of pass) if (C.has(b, k) && b[k] !== undefined) body[k] = b[k];
        const r = captureRes();
        await coreHandler({ body, shopAccess: access }, r);
        line.result = r.code >= 200 && r.code < 300 ? "ok" : (C.isObj(r.body) && r.body.error) || `status_${r.code}`;
        if (line.result !== "ok") return passFail(res, r);
        return ok(res, shape(r.body, shop));
      } catch (e) {
        line.result = e instanceof C.Refusal ? e.deny.error : "internal_error";
        throw e;
      } finally {
        log(line);
      }
    });
  };
}

const merchantProductsList = relay("products/list", ["q", "cursor"], (d) => require("./shop/productSearch").productSearch(d), (b, shop) => {
  const nameOf = categoryNameOf(shop);
  const items = (Array.isArray(b.items) ? b.items : []).map((it) => {
    const out = { productId: it.productId, name: it.name, price: it.price };
    if (typeof it.imageId === "string" && it.imageId) out.imageUrl = it.imageId;
    const cat = nameOf(it.category);
    if (cat) out.category = cat;
    out.selected = it.selected === true;
    return out;
  });
  return { items, selectedCount: b.selectedCount, max: S.PRODUCT_LIMIT, nextCursor: b.nextCursor === undefined ? null : b.nextCursor };
});

const merchantProductsSet = relay("products/set", ["productIds"], (d) => require("./shop/productsSet").productsSet(d), (b) => ({ selectedCount: b.productCount }));

// ── ordering (เฉพาะ enabled · minOrder · deliveryFeeModel · maxKm) ───────────────────────────
const ORDERING_KEYS = ["enabled", "minOrder", "deliveryFeeModel", "maxKm"];
const badModel = (message, errors) => C.refuse(400, "bad_delivery_model", message, { details: { errors } });

/**
 * orderingPatchOf(body) → patch {enabled?, minOrder?, deliveryFeeModel?} (pure · โยน Refusal)
 *   ลำดับ/ข้อความเดียวกับต้นแบบ (`orderingRelayBody` → `parseBody`)
 */
function orderingPatchOf(body) {
  const b = C.isObj(body) ? body : {};
  const extra = Object.keys(b).filter((k) => !ORDERING_KEYS.includes(k) && k !== "shopId");
  if (extra.length) {
    C.refuse(400, "field_not_relayed", `ช่องเหล่านี้ตั้งผ่านเว็บ ScanGo ไม่ได้: ${extra.join(", ")}`, { details: { errors: extra.map((field) => ({ field, message: "ไม่ได้ส่งต่อทางนี้" })) } });
  }
  if (b.maxKm !== undefined) {
    if (b.deliveryFeeModel === undefined) {
      const message = "ไกลสุดคิดจากสูตรค่าส่ง — ส่ง deliveryFeeModel มาด้วย";
      badModel(message, [{ field: "maxKm", message }]);
    }
    const v = DF.validateDeliveryFeeModel(b.deliveryFeeModel);
    if (v.ok && Math.abs(Number(b.maxKm) - DF.maxKmOf(v.model)) > 1e-9) {
      const message = `ไกลสุด (${b.maxKm} กม.) ไม่ตรงกับขอบช่วงสุดท้ายของสูตร (${DF.maxKmOf(v.model)} กม.)`;
      badModel(message, [{ field: "maxKm", message }]);
    }
  }
  const patch = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") C.bad("enabled ต้องเป็น true หรือ false");
    patch.enabled = b.enabled;
  }
  if (b.minOrder !== undefined) {
    const n = typeof b.minOrder === "string" && b.minOrder.trim() !== "" ? Number(b.minOrder) : b.minOrder;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) C.bad("minOrder ต้องเป็นตัวเลข ≥ 0");
    patch.minOrder = Math.round(n * 100) / 100;
  }
  if (b.deliveryFeeModel !== undefined) {
    const v = DF.validateDeliveryFeeModel(b.deliveryFeeModel);
    if (!v.ok) badModel(`สูตรค่าส่งไม่ถูกต้อง: ${v.errors.map((e) => e.message).join(" · ")}`, v.errors);
    patch.deliveryFeeModel = v.model;
  }
  if (!Object.keys(patch).length) C.bad("ต้องส่ง enabled / minOrder / deliveryFeeModel อย่างน้อย 1 ช่อง");
  return patch;
}

/** ก้อน ordering ที่ตอบเว็บ (สูตรที่ใช้จริงหลังรวมค่าเดิม · ท่าเดียวกับต้นแบบ `orderingView` ตัดช่องที่บ้านนี้ไม่มี) */
function orderingViewOf(scango) {
  const s = C.isObj(scango) ? scango : {};
  const d = DF.resolveDeliveryConfig(s);
  const min = typeof s.minOrder === "number" && Number.isFinite(s.minOrder) && s.minOrder >= 0 ? s.minOrder : 0;
  return { enabled: s.enabled === true, minOrder: min, deliveryFee: d.model.baseFee, deliveryFeeModel: d.model, deliveryFeeSource: d.source, maxKm: d.maxKm };
}

function sendVenueOf(deps) {
  const v = deps ? deps.sendVenue : undefined;
  if (v === undefined || v === null) return (...a) => require("./_outbound").sendVenue(...a);
  if (typeof v !== "function") throw new TypeError("deps.sendVenue ต้องเป็นฟังก์ชัน");
  return v;
}

/** แกนของเส้น ordering (รูปเดียวกับ handler ฝั่งแอป: req {body:{shopId,...}, shopAccess}) */
function orderingCore(deps) {
  return async function handler(req, res) {
    try {
      const access = req.shopAccess;
      const { shopId: _sid, ...input } = C.isObj(req.body) ? req.body : {};
      const patch = orderingPatchOf(input);
      if (!isOwner(access)) C.refuse(403, "owner_only", "เฉพาะเจ้าของร้านเท่านั้นที่เปิด/ปิดช่องทาง ScanGo ได้");
      const sendVenue = sendVenueOf(deps);
      const now = await readNow(deps);
      let next = null;
      await db.runTransaction(async (tx) => {
        const { shopRef, shop } = await readShopForWrite({ tx, shopDocId: access.shopId, access, now });
        const prev = C.isObj(shop.scango) ? shop.scango : {};
        if (patch.enabled === true) {
          const missing = S.missingForEnable({ productIds: S.scangoOf(shop).productIds });
          if (missing.length) C.refuse(409, "scango_not_ready", "ยังไม่ได้เลือกสินค้าที่ขายบน ScanGo เปิดรับออเดอร์ไม่ได้", { missing });
        }
        const write = {};
        for (const k of Object.keys(patch)) write[`scango.${k}`] = patch[k];
        tx.update(shopRef, write);
        next = { ...prev, ...patch };
      });
      let venue = "failed";
      let reason = null;
      try {
        const r = await sendVenue(deps, { shopId: access.shopId });
        venue = C.isObj(r) && S.VENUE_STATUSES.includes(r.status) ? r.status : "failed";
        if (C.isObj(r) && typeof r.reason === "string" && r.reason) reason = r.reason;
      } catch (e) {
        try { console.error("scango.merchantOrdering sendVenue", e && e.name, e && e.message); } catch (_) { /* ไม่ล้มคำตอบ */ }
      }
      return ok(res, { ordering: orderingViewOf(next), synced: venue === "sent", venue, ...(reason ? { reason } : {}) });
    } catch (e) {
      if (e instanceof C.Refusal || e instanceof GateRefusal || e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

const merchantOrdering = relay("ordering", ORDERING_KEYS, orderingCore, (b) => {
  const { ok: _ok, ...rest } = b;
  return rest;
}, { passAll: true });

// ── fee/preview (คิดอย่างเดียว · สูตรที่ยังไม่บันทึก) ─────────────────────────────────────────
function feePreviewCore() {
  return async function handler(req, res) {
    const b = C.isObj(req.body) ? req.body : {};
    const { ok: _ok, ...out } = DF.feePreview({ deliveryFeeModel: b.deliveryFeeModel, maxKm: b.maxKm, distancesKm: b.distancesKm });
    return ok(res, out);
  };
}
const merchantFeePreview = relay("fee/preview", ["deliveryFeeModel", "maxKm", "distancesKm"], feePreviewCore, (b) => {
  const { ok: _ok, ...rest } = b;
  return rest;
});

module.exports = {
  merchantProductsList, merchantProductsSet, merchantOrdering, merchantFeePreview, _orderingCore: orderingCore,
  actorOf, accessOf, categoryNameOf, orderingPatchOf, orderingViewOf, ACTOR_UID_RE, ORDERING_KEYS,
};
