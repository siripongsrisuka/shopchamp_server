// pos/promotion/list.js — promotion.list · POST /pos/promotion/list (DEV-0010 คลื่น 2 · ชุดตกหล่น · อ่านอย่างเดียว)
//
// แทน fetchPromotion `shopchamp_app/src/redux/promotionSlice.js:35` (ผู้เรียก HomeScreen.js:276 ตอนเปิดหน้าแรก)
//   ของเดิม: promotion where shopId == shop.shopId (ไม่มี limit) · แอปเรียกเฉพาะเมื่อ premiumEnable (`HomeScreen.js:275`)
//   ใหม่:    promotion where shopId == K (ไม่มี limit แบบเดิม) → {promotions:[{...doc, id}]} เรียง doc id
//   คืน doc เต็ม (เครื่องคิดโปรในตะกร้า Cashier/Summary/Checkout/BarcodeCart ใช้ทุกช่อง · updatedAt ใช้เป็น baseUpdatedAt ตอนแก้)
//     เวลาทุกช่อง (startDate endDate timestamp updatedAt · ซ้อนในก้อนด้วย) เป็น ISO · ตัดเฉพาะรอยทีมงาน/ผู้แก้ (STRIP ตัวเดียวกับ stock.sync)
//     ไม่ทำระบบปกปิด (Pack 2026-11-14 ข้อ 7)
//   แบบที่ยึดจากพี่น้อง: promotionList ของแอปพี่น้อง (ดู lanes/dev/source/dev0010-survey-stock.md §5) · ตัดเหลือขอบเขตร้าน (แอปบ้านนี้ถามแค่ shopId)
// K = ช่อง shopId ของ doc ร้านที่ผู้เรียกผ่านด่านแล้ว (ไม่มี/ไม่ใช่สตริง = doc id) · แบบแอปเดิม (Pack 2026-11-14 ข้อ 8)
// ด่าน: requireShopAccess → callerAccess อ่านอย่างเดียว (watcher ผ่าน) · ไม่มีเลขสิทธิ์ (แคชเชียร์ต้องใช้คิดโปร · แอปเดิมโหลดให้ทุกคนที่เข้าหน้าแรก)
//   พรีเมี่ยมหมด = 403 premium_required (แอปเดิมไม่โหลดเลย · Pack 2026-11-14 ข้อ 9)
// ค่าอ่าน: shop 1 ครั้ง (ด่าน · handler ใช้ doc ที่ด่านแนบ shopSnapOf ไม่อ่านซ้ำ) + doc ที่ได้ (ขั้นต่ำ 1) · เท่าแอปเดิม
// อ่านอย่างเดียว ไม่เขียน · แอปเก่าไม่เห็นอะไรเปลี่ยน · ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminFlag, shopSnapOf } = require("../_shared/auth");
const { isPremiumActive } = require("../_shared/premium");
const { toPlain } = require("../_shared/syncCursor");
const { STRIP } = require("../stock/syncRead");
const { isObj } = require("../member/_gate");

function schemaOf(name) {
  const s = require("@shopchamp/schema")[name];
  if (!s || typeof s.safeParse !== "function") throw new Error(`@shopchamp/schema ไม่มี ${name}`);
  return s;
}

function list(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId, { read: true });
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(schemaOf("PromotionListRequest"), body, res);
      if (!input) return;
      const snap = await shopSnapOf(db, access);
      if (!snap.exists) return sendDeny(res, deny(404, "shop_not_found"));
      const shop = snap.data() || {};
      const now = await readNow(deps);
      if (!isPremiumActive(shop, now)) return sendDeny(res, deny(403, "premium_required", "ฟีเจอร์ สำหรับแพ็กเกจพรีเมี่ยม"));
      const key = typeof shop.shopId === "string" && shop.shopId !== "" ? shop.shopId : access.shopId;

      const ps = await db.collection("promotion").where("shopId", "==", key).get();
      const promotions = (ps.docs || [])
        .map((s) => ({ id: s.id, d: s.data() || {} }))
        .filter((r) => r.d.shopId === key)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => {
          const out = {};
          for (const k of Object.keys(r.d)) if (!STRIP.includes(k)) out[k] = toPlain(r.d[k]);
          out.id = r.id;
          return out;
        });
      return ok(res, { ...adminFlag(access), promotions });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { list };
