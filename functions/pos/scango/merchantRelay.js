// pos/scango/merchantRelay.js — เว็บร้าน ScanGo ส่งต่อมาทำแทนคนในร้าน (auth 'partner' · รอบ 4 Pack เคาะ 2026-11-12)
//
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/scango/merchantRelay.js` › asPlatformOwner + relay ต่อ op
//   ผู้เรียก = เซิร์ฟเวอร์ ScanGo (กุญแจร่วม · _partnerAuth.js) ในนามคนที่เข้าเว็บร้านแล้ว (connector shopchamp › merchantRelay)
//   ท่าเดียวกับต้นแบบ: **ใช้ handler เดิมไม่แก้สักบรรทัด** — ตั้ง req.shopAccess + req.body.shopId แบบที่ requireShopAccess ตั้งให้แอป
//     แล้วเรียก `shop/productSearch` / `shop/productsSet` ตัวจริง ⇒ ด่านสิทธิ์ '111' · เพดาน 1000 · ตรวจสินค้ามีจริง = ของเดิมทุกไบต์
//   🔒 actor บังคับ: {uid:'mo:…'|'md:…'|'ms:…'|'admin:…', personRef, name?} ไม่มี/ผิดรูป = 400 actor_required (ไม่ทำแทนใครแบบไม่มีชื่อ)
//   🔒 ปิดรายร้าน: shop.scango.merchantRelay === false = 403 merchant_relay_disabled
//   🔒 log ทุกคำขอ 1 บรรทัด {message:'scango.merchantRelay', op, shopId, actor, personRef6, result}
//   ต่างจากต้นแบบ 1 ข้อ (บอก Pack): ต้นแบบตั้ง role owner ให้ทุกคำขอ · ที่นี่ **ตัดสินสิทธิ์จากแถวของ actor.personRef ใน shop.humanResource ตอนนั้น**
//     (memberStatusOf + roleOf ตัวเดียวกับ requireShopAccess) ⇒ เจ้าของ = owner · พนักงาน = rights ของตัวเอง (ไม่มี '111' = 403 right_required)
//     · ไม่ใช่คนในร้าน/ไม่ active (รวม md:/admin: ของทีม ScanGo ที่ไม่ได้อยู่ในร้าน) = 403 not_shop_member
//     เหตุ: handler ของบ้านนี้ตรวจสมาชิกซ้ำใน transaction (member/_gate.readShopForWrite) ⇒ ตั้ง owner ปลอมก็เขียนไม่ได้อยู่ดี
//
// POST /pos/scango/merchant/products/list {externalId, q?, cursor?, actor}  (scango.merchantProductsList)
//   → 200 {items:[{productId, name, price, imageUrl?, category?, selected}], selectedCount, max:1000, nextCursor}
//   แกน = shop/productSearch (หน้าละ ≤50 · ⚠️ ได้น้อยกว่า 50 แต่ nextCursor ไม่ null ได้ ⇒ เว็บเรียกต่อจน null)
//   imageUrl = stock.imageId (เป็น URL อยู่แล้ว · ว่าง = ไม่ใส่ช่อง) · category = ชื่อหมวดชั้นลึกสุดในเส้นทางที่เจอใน shop.smartCategory (ไม่เจอ = ไม่ใส่)
// POST /pos/scango/merchant/products/set {externalId, productIds, actor}  (scango.merchantProductsSet)
//   → 200 {selectedCount} · แกน = shop/productsSet (แทนทั้งรายการ · ≤1000 · มีจริงในร้าน · ตัดซ้ำ)
// คำตอบไม่สำเร็จของแกน = ส่งต่อทั้งสถานะและซอง (400 invalid_request · 403 right_required · 409 too_many_products · 409 product_not_found ฯลฯ)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { ok, fail } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { memberStatusOf, roleOf } = require("../_shared/auth");
const C = require("./_core");
const S = require("./shop/_common");

const ACTOR_UID_RE = /^(mo|md|ms|admin):[^\s]{1,160}$/; // ชุดเดียวกับต้นแบบ (ms: = พนักงานเว็บร้าน ScanGo)
const short6 = (v) => (typeof v === "string" ? v.slice(0, 6) : "");

/** actorOf(raw) → {uid, personRef, name} · ผิดรูป = 400 actor_required */
function actorOf(raw) {
  if (!C.isObj(raw)) C.refuse(400, "actor_required", "ต้องส่ง actor {uid, personRef} ของคนที่กดบนเว็บ");
  const uid = C.str(raw.uid);
  if (!ACTOR_UID_RE.test(uid)) C.refuse(400, "actor_required", "actor.uid ต้องขึ้นต้น mo: / md: / ms: / admin:");
  const personRef = C.str(raw.personRef);
  if (!C.ID_RE.test(personRef)) C.refuse(400, "actor_required", "actor.personRef ต้องเป็นรหัสบัญชี Shopchamp ของคนที่กด");
  return { uid, personRef, name: C.str(raw.name).slice(0, 80) || null };
}

/** accessOf(shop, shopId, actor, now) — สิทธิ์จริงของ actor.personRef ในร้าน (ตัวตัดสินเดียวกับ requireShopAccess · ไม่มีทางทีมงาน) */
function accessOf(shop, shopId, actor, now) {
  const m = memberStatusOf(shop, actor.personRef, now);
  if (m.status !== "active") C.refuse(403, "not_shop_member", "บัญชีนี้ไม่ได้เป็นคนในร้านนี้แล้ว", { reason: m.status });
  const role = roleOf(m.person);
  const rights = role === "staff" && Array.isArray(m.person.rights) ? m.person.rights.filter((x) => typeof x === "string") : [];
  return { shopId, uid: actor.personRef, role, rights, via: "scango", scangoActor: actor.uid };
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
function relay(op, keys, core, shape) {
  return function factory(deps) {
    const log = logOf(deps);
    const coreHandler = core(deps);
    return C.wrap(async (req, res) => {
      const line = { op, shopId: "", actor: "", personRef6: "", result: "" };
      try {
        const b = C.bodyOf(req);
        C.onlyKeys(b, ["externalId", "actor", ...keys]);
        const shopId = C.idOf(b.externalId, "externalId");
        line.shopId = shopId;
        const actor = actorOf(b.actor);
        line.actor = actor.uid; line.personRef6 = short6(actor.personRef);
        const now = await readNow(deps);
        const shop = await C.loadShop(shopId);
        if (C.isObj(shop.scango) && shop.scango.merchantRelay === false) C.refuse(403, "merchant_relay_disabled", "ร้านนี้ปิดการตั้งค่าผ่านเว็บ ScanGo ไว้");
        const access = accessOf(shop, shopId, actor, now);

        const body = { shopId };
        for (const k of keys) if (C.has(b, k) && b[k] !== undefined) body[k] = b[k];
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

module.exports = { merchantProductsList, merchantProductsSet, actorOf, accessOf, categoryNameOf, ACTOR_UID_RE };
