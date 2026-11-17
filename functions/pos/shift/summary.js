// pos/shift/summary — ยอดสรุปรอบกะที่เปิดอยู่ ชุดเดียวกับที่ปิดกะใช้ (DEV-0011 ข้อ ⑤ · จอกะ "เงินที่คาดไว้")
//
// สัญญา: shopchamp-center/api/shift.summary.yaml (ร่าง · รอ Pack เซ็นชุด case) · route POST /pos/shift/summary (auth shop · อ่านอย่างเดียว)
// แทน: ยอดเงินคาดของจอกะที่คิดเองจาก route เดิม `/shift/test` (`shopchamp_app/src/screens/ShiftScreen.js` ก่อน DEV-0011)
//   route เดิมอ่านแค่ bill ⇒ ไม่มีเงินเซ็นที่รับเป็นเงินสด (paidHistory) ⇒ จอโชว์เงินคาดต่ำกว่าที่ server ใช้ปิด ⇒ ปิดกะเจอ 409 summary_changed
// คิดด้วย manage.js › roundInputOf + logic.roundSummary = ตัวเดียวกับ close (logic.closeShift เรียก roundSat ตัวเดียวกัน) ⇒ expectedCash ตรงตอนปิดระดับสตางค์
// คำขอ: ShiftGetRequest {shopId, shiftId} (ใช้ schema เดิม · ไม่ bump @shopchamp/schema)
// คำตอบ: {ok, shiftId, openTime(ISO), expectedCash, summary:{...roundSummary ไม่มี outside · outsideQty}, byAdmin?}
// ด่าน: requireShopAccess → callerAccess อ่านอย่างเดียว (watcher ผ่าน · แบบ shift.get) → ด่านซ้ำสมาชิก active
//   ไม่มีเลขสิทธิ์: แคชเชียร์ทั่วไปเห็นเงินคาดบนจอกะอยู่แล้ว (ShiftScreen ไม่ตรวจสิทธิ์ส่วนลิ้นชัก) · ส่วนสรุปยอดขาย จอซ่อนเองตามสิทธิ์ 132 เหมือนเดิม
//   ของร้านไหม: checkOwnedDoc แบบ shift.manage (resolveShopRef) · ไม่มี 404 shift_not_found · ร้านอื่น 409 shift_other_shop
//   กะปิดอยู่ 409 shift_not_open · openTime อ่านไม่ได้ 409 shift_open_time_bad
// Firestore อ่าน (ต่อครั้ง): shop 0-1 (ด่านแนบ doc แล้วไม่อ่านซ้ำ) · resolveShopRef 0 หรือ 2 (เฉพาะร้านที่ช่อง shopId ไม่ใช่ doc id) · shift 1
//   · bill 2 query (ป้ายรอบ ∪ เวลา >= openTime) · paidHistory 2 query — ค่า read = จำนวน doc ที่แต่ละ query คืน (บิลแอปใหม่ติดทั้ง 2 query = นับ 2)
//   ⇒ ≈ 2 + 2×(บิลในรอบ) + 2×(ใบรับชำระในรอบ) (query ว่างคิด 1) · เท่ากับที่ปิดกะ/คำเตือนเงินออกอ่านอยู่แล้ว · เขียน: ไม่มี
// ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, deny, parseOr400, internalError } = require("../_shared/respond");
const { callerAccess, adminFlag, shopSnapOf, resolveShopRef, checkOwnedDoc } = require("../_shared/auth");
const { schemaOf } = require("../stock/_shared");
const { memberDeny } = require("../shop/_appView");
const { roundInputOf, summaryForResponse, SHIFT_MESSAGES } = require("./manage");

const isoOf = (t) => {
  const ms = logic.toMillis(t);
  return ms === null ? null : new Date(ms).toISOString();
};

function summary(_deps) {
  return async function handler(req, res) {
    try {
      const body = req && req.body && typeof req.body === "object" ? req.body : {};
      const gate = callerAccess(req, body.shopId, { read: true });
      if (!gate.ok && gate.status === 401) return sendDeny(res, gate);
      const input = parseOr400(schemaOf("ShiftGetRequest"), body, res);
      if (!input) return res;
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;

      const [shopSnap, shiftSnap] = await Promise.all([
        shopSnapOf(db, access),
        db.collection("shift").doc(input.shiftId).get(),
      ]);
      if (!shopSnap.exists) return sendDeny(res, deny(404, "shop_not_found"));
      const shop = shopSnap.data() || {};
      const denied = memberDeny(shop, access);
      if (denied) return sendDeny(res, denied);
      const shopRef = await resolveShopRef({ db, shopDocId: access.shopId, shop });

      const shift = shiftSnap && shiftSnap.exists ? shiftSnap.data() : undefined;
      const owned = checkOwnedDoc("shift", shift, shopRef);
      if (!owned.ok) return sendDeny(res, owned);
      if (shift.status !== true) return sendDeny(res, deny(409, "shift_not_open", SHIFT_MESSAGES.shift_not_open));

      const loaded = await roundInputOf((q) => q.get(), { shiftId: input.shiftId, shift, shop, shopRef });
      if (!loaded) return sendDeny(res, deny(409, "shift_open_time_bad", SHIFT_MESSAGES.shift_open_time_bad));
      const s = logic.roundSummary(loaded.input);
      return ok(res, {
        ...adminFlag(access),
        shiftId: input.shiftId,
        openTime: isoOf(shift.openTime),
        expectedCash: s.expectedCash,
        summary: summaryForResponse(s),
      });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { summary };
