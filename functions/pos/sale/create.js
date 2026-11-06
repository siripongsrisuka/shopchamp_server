// pos/sale/create — ออกบิลขาย 1 ใบ (ออนไลน์ + บิลออฟไลน์ที่ซิงก์ขึ้นมา) (ก้อน 4 · DEV-0001)
//
// สถานะ: โครงเปล่า · ตอบ 501 not_implemented ทุกคำขอ · ยังไม่ export จาก index.js และยังไม่ deploy
//   มีไว้ให้สัญญา shopchamp-center/api/sale.create.yaml ชี้ไฟล์จริงได้ ⇒ Pack เซ็นชุด case ได้ก่อนเขียนโค้ด
//   หลัง Pack เซ็น harness จะรัน case จริง และตกจนกว่าจะเขียน handler ตามสัญญา
// รูป: factory (deps) => handler(req, res) · deps: now · now() ไม่ส่ง = new Date()
// ❌ ห้าม require SDK ตัวจริงตรงนี้ (harness ปัดถ้าโหลด firebase-admin) · ใช้ ../../firebase เท่านั้น

function create(deps) { // eslint-disable-line no-unused-vars
  return async function handler(req, res) {
    return res.status(501).json({ ok: false, error: "not_implemented", message: "ยังไม่เปิดใช้" });
  };
}

module.exports = { create };
