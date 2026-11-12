// pos/scango/shop/settingsSave — บันทึกค่าตั้ง ScanGo ของร้าน แล้วบอก ScanGo ว่าร้านเปิด/ปิดรับใบ (สัญญา scango.settingsSave · auth 'shop')
//
// คำขอ (ทุกช่องบังคับ · ช่องเกิน = 400):
//   {shopId, enabled, location:{lat,lng}|null, hours:[{day 0-6, open 'HH:mm', close 'HH:mm'}], minOrder, deliveryFee,
//    freeDeliveryMin|null, maxKm, prepMinutes, paymentQr ('' หรือ URL https), pickupNote}
//   hours: เปิดก่อนปิด (ข้ามเที่ยงคืน = แยก 2 แถว) · ช่วงในวันเดียวกันห้ามทับ · ≤3 ช่วงต่อวัน · รวม ≤21 แถว
// ด่าน: callerAccess (เขียน) → schema 400 invalid_request → เจ้าของเท่านั้น 403 owner_required
//   transaction: shop ไม่มี 404 · ผู้เรียกไม่ active 403 not_shop_member · enabled:true แต่ยังไม่เลือกสินค้า (รอบ 5: ไม่ดูพิกัด/เวลาแล้ว)
//   = 409 scango_not_ready {missing:[...]} (สินค้านับจาก shop.scango.productIds ที่ productsSet ตรวจแล้ว)
//   เขียน `tx.update` เฉพาะ `scango.<ช่องในคำขอ>` (dotted) ⇒ productIds และช่องอื่นของร้านไม่ถูกแตะ
// หลัง commit: ส่ง venue_ordering ด้วย deps.sendVenue หรือ `../_outbound`.sendVenue(deps, {shopId, enabled, settings})
//   ค่าตั้งบันทึกแล้วเสมอ ตอบ 200 พร้อม venue = สถานะจริงที่ sendVenue คืน (`_outbound.venueStatusOf`):
//     'sent' ถึง ScanGo แล้ว · 'queued' ยิงไม่ออก ลง outbox รอยิงซ้ำทุก 1 นาที · 'skipped' ยังไม่ตั้ง env ฝั่ง server (ไม่ได้ยิง) ·
//     'failed' ScanGo ปฏิเสธ/พัง และไม่มีคิว (รวม sendVenue โยน หรือคืนรูปที่ไม่รู้จัก — ไม่เดาว่าส่งแล้ว)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../../_shared/respond");
const { readNow } = require("../../_shared/deps");
const { callerAccess, isOwner, adminFlag } = require("../../_shared/auth");
const { readShopForWrite, Refusal: GateRefusal } = require("../../member/_gate");
const C = require("./_common");

function sendVenueOf(deps) {
  const v = deps ? deps.sendVenue : undefined;
  if (v === undefined || v === null) return (...a) => require("../_outbound").sendVenue(...a);
  if (typeof v !== "function") throw new TypeError("deps.sendVenue ต้องเป็นฟังก์ชัน");
  return v;
}

function settingsSave(deps) {
  return async function handler(req, res) {
    try {
      const body = C.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(C.SettingsSaveRequest, body, res);
      if (!input) return;
      if (!isOwner(access)) return sendDeny(res, deny(403, "owner_required", C.OWNER_REQUIRED));
      const sendVenue = sendVenueOf(deps);
      const now = await readNow(deps);

      const settings = {};
      for (const k of C.SETTING_FIELDS) settings[k] = input[k];

      await db.runTransaction(async (tx) => {
        const { shopRef, shop } = await readShopForWrite({ tx, shopDocId: access.shopId, access, now });
        if (settings.enabled) {
          const missing = C.missingForEnable({ ...settings, productIds: C.scangoOf(shop).productIds });
          if (missing.length) C.refuse(409, "scango_not_ready", "ตั้งค่ายังไม่ครบ เปิดรับออเดอร์ไม่ได้", { missing });
        }
        const patch = {};
        for (const k of C.SETTING_FIELDS) patch[`scango.${k}`] = settings[k];
        tx.update(shopRef, patch);
      });

      let venue = "failed";
      try {
        const r = await sendVenue(deps, { shopId: access.shopId, enabled: settings.enabled, settings });
        venue = C.isObj(r) && C.VENUE_STATUSES.includes(r.status) ? r.status : "failed";
      } catch (e) {
        try { console.error("scango.settingsSave sendVenue", e && e.name, e && e.message); } catch (_) { /* ไม่ล้มคำตอบ */ }
      }
      return ok(res, { scango: settings, venue, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof C.Refusal || e instanceof GateRefusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { settingsSave };
