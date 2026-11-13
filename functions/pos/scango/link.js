// pos/scango/link.js — POST /pos/scango/link {externalId, linked} (auth 'partner' · ScanGo บอกว่าร้านเปิด/ปิดช่องทาง ScanGo · DEV-0009 Pack เคาะ 1 2026-11-13)
//
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/scango/link.js` (parseLinkBody · เขียน shop.scango.linked + แถวช่องทาง)
//   ผู้เรียก = scango_server origin/main connector ของแอปพี่น้อง (`providers/<พี่น้อง>/connector.js`) › setLinked (ยิงตอนร้านพลิก venues.ordering.enabled บนเว็บร้าน)
//   ⚠️ connector shopchamp ฝั่ง ScanGo (`providers/shopchamp/connector.js`) ยังไม่มี setLinked ⇒ เส้นนี้ยังไม่มีใครเรียกจนกว่าฝั่ง ScanGo เติม
// ต่างจากต้นแบบ: เขียน `shop.scango.enabled` (ช่องที่แอปอ่าน `scangoEnabled` · ป๊อปอัปใบใหม่ฟังเมื่อ true · shop/loginStatus นับ connected)
//   แทน `shop.scango.linked` · ❌ ไม่มีแถว channel[] (บ้านนี้ไม่มีถังราคาช่องทาง)
// ตรวจ: ช่องเกิน/externalId ผิดรูป/linked ไม่ใช่ boolean = 400 invalid_request · ร้านไม่มี = 404 shop_not_found
// เขียน update ช่องเดียว `scango.enabled` (dotted · ช่องอื่นใน scango ไม่ถูกแตะ) → 200 {ok, linked}
"use strict";

const { db } = require("../../firebase");
const { ok } = require("../_shared/respond");
const C = require("./_core");

function link(_deps) {
  return C.wrap(async (req, res) => {
    const b = C.bodyOf(req);
    C.onlyKeys(b, ["externalId", "linked"]);
    const shopId = C.idOf(b.externalId, "externalId");
    if (typeof b.linked !== "boolean") C.bad("linked ต้องเป็น true หรือ false");
    await C.loadShop(shopId);
    await db.collection("shop").doc(shopId).update({ "scango.enabled": b.linked });
    return ok(res, { linked: b.linked });
  });
}

module.exports = { link };
