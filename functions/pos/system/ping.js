// pos/system/ping — handler ตัวแรกของ API ใหม่ (ก้อน 0 · DEV-0001)
//
// หน้าที่: พิสูจน์ทาง สัญญา API → harness → handler จริง · ยังไม่ export จาก index.js และยังไม่ deploy
// ก้อน 4 จะต่อเข้า pos/app.js ใต้ด่าน checkIfAuthenticated + requireShopAccess
//   (middleware เป็นคนผูก req.shopAccess กับสิทธิ์ผู้เรียก · handler ไม่เชื่อ body)
//
// สัญญา: shopchamp-center/api/system.ping.yaml
//   ไม่มี req.shopAccess.shopId      → 401 no_shop_access (กันลืมใส่ middleware · fail-closed)
//   ร้านไม่มีในฐาน                   → 404 shop_not_found
//   ผ่าน                             → 200 { ok: true, service: "pos", shopId }
//   ❌ ไม่คืนข้อมูลของ doc ร้าน
// ซองคำตอบ (ทุก route ของ pos · ก้อน 4): ไม่สำเร็จ = {ok:false, error:<code>, message:<ไทย>} · เดิมใช้ช่อง code ตัวใหญ่ แก้ 2026-11-06
const { db } = require("../../firebase");

async function ping(req, res) {
  const access = req && req.shopAccess;
  const shopId = access && typeof access.shopId === "string" ? access.shopId : "";
  if (!shopId) {
    return res.status(401).json({ ok: false, error: "no_shop_access", message: "ไม่มีสิทธิ์เข้าร้าน" });
  }
  try {
    const snap = await db.collection("shop").doc(shopId).get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: "shop_not_found", message: "ไม่พบร้าน" });
    }
    return res.status(200).json({ ok: true, service: "pos", shopId: shopId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "internal_error", message: "ระบบขัดข้อง" });
  }
}

module.exports = { ping };
