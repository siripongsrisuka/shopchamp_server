// pos/_shared/auth.js — ด่านตัวตนและด่านร้านของทุก route ใน pos (ก้อน 4 · DEV-0001)
//
// สถานะ: โครงเปล่า · ทั้ง 2 ตัวตอบ 501 not_implemented · ยังไม่มี route ไหนใช้ · ยังไม่ export จาก index.js
//
// ความหมายที่สัญญา shopchamp-center/api/*.yaml อ้าง (เขียนจริงตามนี้):
//   checkIfAuthenticated(req, res, next)
//     verifyIdToken(token, true) · ไม่มี/ไม่ผ่าน → 401 {ok:false, error:"no_auth"} · ผ่าน → req.auth = {uid}
//   requireShopAccess(req, res, next)   (ต่อหลัง checkIfAuthenticated · ร้านเป้าหมาย = body.shopId)
//     ① shop/{shopId} ไม่มี → 404 shop_not_found
//     ② ผู้เรียกอยู่ใน shop.humanResource และ active (คนที่ไม่ใช่ index 0 ต้องมีแพ็กเกจ staff ยังไม่หมด · กติกาแอปเก่า)
//        → req.shopAccess = {shopId, uid, role:'owner'|'staff', rights}   (owner = position มี '001')
//     ③ ไม่ผ่าน ② แต่ uid อยู่ใน admin/adminConfig.admin (ทีมงาน Shopchamp · Pack เคาะ 2026-11-06 ข้อ 3-2)
//        → req.shopAccess = {shopId, uid, role:'owner', rights:[], byAdmin:true}   สิทธิ์เต็มเหมือนเจ้าของ
//        ที่มา: แอปเก่า app:src/screens/LoadingScreen.js:63,77,83 · WelcomeScreen.js:116,132 (admin.includes(uid) ⇒ ทะลุ + initialRights)
//        doc admin/adminConfig ไม่มี หรือช่อง admin ไม่ใช่ array = ไม่มีใครเป็นทีมงาน (fail-closed)
//     ④ ไม่ผ่านทั้งคู่ → 403 {ok:false, error:"not_shop_member"}
//   handler ทุกตัวเขียน {byAdmin:true, adminUid} เพิ่มบนเอกสารที่เขียน เมื่อ req.shopAccess.byAdmin (ตามรอยได้ว่าทีมงานทำ)
//   ⚠️ harness รัน middleware ไม่ได้ ⇒ ตัวนี้ต้องมีเทสข้างไฟล์ของตัวเองตอนเขียนจริง (ทั้งทาง ② ③ ④ และ adminConfig หาย)

function notImplemented(req, res) {
  return res.status(501).json({ ok: false, error: "not_implemented", message: "ยังไม่เปิดใช้" });
}

function checkIfAuthenticated(req, res, next) { // eslint-disable-line no-unused-vars
  return notImplemented(req, res);
}

function requireShopAccess(req, res, next) { // eslint-disable-line no-unused-vars
  return notImplemented(req, res);
}

module.exports = { checkIfAuthenticated, requireShopAccess };
