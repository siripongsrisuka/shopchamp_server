// pos/scango/shop/loginStatus — ไทล์ ScanGo บนหน้าแรกของแอปร้านถามก่อนเปิดจอ (สัญญา scango.loginStatus · auth 'shop')
//
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/scango/settingsStatus.js` (POST /scango/settings-login/status)
//   ยังไม่เปิดบน ScanGo = หน้าแนะนำ · เปิดแล้ว + เจ้าของ = เว็บร้าน ScanGo · เปิดแล้ว + ไม่ใช่เจ้าของ = หน้าอธิบาย
// คำขอ {shopId} · คำตอบ 200 {ok, connected, isOwner}
//   connected = ร้านนี้มีใบสถานที่บน ScanGo แล้ว — ฝั่งนี้ไม่มีทะเบียนสถานที่ของ ScanGo ⇒ นับจากรอยที่ทำให้ ScanGo สร้างใบแน่ ๆ:
//     ① shop.scango.merchantLinkedAt — เจ้าของเข้าเว็บร้านสำเร็จแล้วอย่างน้อย 1 ครั้ง (ประทับใน scango.loginRedeem ·
//        ScanGo สร้างใบขั้นต่ำตอนแลก: scango_server `functions/auth/posExchange.js` › upsertVenueFromProvider)
//     ② shop.scango.enabled เป็น boolean — มีแต่ scango.settingsSave ที่เขียนช่องนี้ และทุกครั้งตามด้วยยิง venue_ordering
//        (ScanGo upsert ใบสถานที่ · ปิดภายหลังใบยังอยู่) · ❌ ไม่นับแค่ "มีก้อน scango" เพราะ scango.productsSet เขียน
//        scango.productIds ได้โดยไม่เคยบอก ScanGo
//     ต้นแบบมี ③ smartQue (คิว ScanGo · บ้านนี้ไม่มี) ④ ค้นใบ login ที่ claimed (เผื่อร้านที่แลกก่อนมีช่อง ① · บ้านนี้ ① เกิดพร้อม redeem
//     ไม่มีร้านค้าง) ⇒ ตัด 2 ข้อนี้ · ไม่ต้องมี index ประกอบ
//   isOwner = แถวเจ้าของ active ใน shop.humanResource (`../settingsLogin`.ownerOf — ตัวตัดสินเดียวกับ loginStart และ loginRedeem)
//     ⇒ ทีมงาน Shopchamp (root/watcher) ที่ไม่ได้อยู่ในร้าน = false (ต้นแบบ: root ไม่นับ · สัญญา R1)
// ด่าน: callerAccess (อ่าน · ทุกคนในร้าน) → schema 400 → ร้านไม่มี 404 · อ่านอย่างเดียว ไม่เขียนฐาน
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../../_shared/respond");
const { readNow } = require("../../_shared/deps");
const { callerAccess } = require("../../_shared/auth");
const { ownerOf } = require("../settingsLogin");
const C = require("./_common");

/** connectedOf(shop) — pure (①②) */
function connectedOf(shop) {
  const s = shop && C.isObj(shop.scango) ? shop.scango : {};
  if (s.merchantLinkedAt) return true;
  return typeof s.enabled === "boolean";
}

function loginStatus(deps) {
  return async function handler(req, res) {
    try {
      const body = C.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId, { read: true });
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(C.SettingsGetRequest, body, res);
      if (!input) return;
      const now = await readNow(deps);
      const snap = await db.collection("shop").doc(access.shopId).get();
      if (!snap.exists) return sendDeny(res, deny(404, "shop_not_found"));
      const shop = snap.data() || {};
      return ok(res, { connected: connectedOf(shop), isOwner: !!ownerOf(shop, access.uid, now) });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { loginStatus, connectedOf };
