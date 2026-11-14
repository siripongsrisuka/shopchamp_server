// pos/shift/history — ประวัติกะของวันเปิดกะที่ระบุ (DEV-0010 คลื่น 2 · กลุ่ม bill/shift)
//
// สัญญา: shopchamp-center/api/shift.history.yaml · route POST /pos/shift/history (auth shop · อ่านอย่างเดียว)
// แทน: `shopchamp_app/src/screens/ShiftHistoryScreen.js:79` (shiftHistory where shopId == shop.shopId · lastShiftDate in [7 วัน] · ไม่ limit)
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง `functions/claude/shift/history.js:20-33` (dates บังคับ 1-10 · doc เต็ม `{...doc, id}`)
// ทำไมไม่ขยาย report.shiftHistory: ตัวนั้นค้นวันธุรกิจของเวลาปิด (ชุดกะต่างจากเดิมที่ขอบวัน) · แถวเปลี่ยนชื่อช่อง ·
//   อยู่ pos_heavy · เว็บเจ้าของร้านใช้อยู่ ⇒ เส้นใหม่ไม่แตะผู้เรียกเดิมเลย และได้ชุดกะ/ช่องเท่าแอปเดิมเป๊ะ
// คำตอบ: {ok, history:[{...doc ทุกช่อง · Timestamp เป็น ISO · id = doc id}], byAdmin?} · ลำดับตามที่ฐานคืน (แอปเดิมไม่ orderBy)
//   ประวัติกะรุ่นแรกที่เวลาเป็น map {_seconds,_nanoseconds} ส่งเป็น map เดิม (แอป formatTime อ่านได้อยู่แล้ว)
// ค่าค้น shopId = ช่อง shopId ของ doc ร้านที่ผ่านด่านแล้ว · ไม่มี = doc id (Pack 2026-11-14 ข้อ 8 · แบบแอปเดิม)
// สิทธิ์ (Pack ข้อ 9 · เท่าที่แอปเปิดตอนนี้): จอเปิดจากจอกะ (เมนู 102 `HomeScreen.js:79`) + พรีเมียม (`ShiftScreen.js:338` openHistory)
//   เจ้าของ/ทีมงานผ่านสิทธิ์ · พรีเมียมหมด = 403 premium_required ทุกคน (แอปเดิมปัดทุกคนรวมทีมงาน)
// Firestore อ่าน: shop 1 ครั้ง (ด่าน requireShopAccess · handler ใช้ doc ที่ด่านแนบ shopSnapOf ไม่อ่านซ้ำ) · shiftHistory ของวันที่ขอ · index เดียวกับแอปเดิม (equality + in) · เขียน: ไม่มี
// ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { ok, fail, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { callerAccess, adminFlag, hasRight, shopSnapOf } = require("../_shared/auth");
const { readNow } = require("../_shared/deps");
const { isPremiumActive } = require("../_shared/premium");
const { schemaOf } = require("../stock/_shared");
const { memberDeny } = require("../shop/_appView");
const { toClientJson } = require("../sale/getSerialize");
const { shopKey } = require("./get");

const RIGHT = "102"; // เปิด-ปิดกะ (main3 src/screens/StaffScreen.js · เมนู HomeScreen.js:79)

function history(deps) {
  return async function handler(req, res) {
    try {
      const body = req && req.body && typeof req.body === "object" ? req.body : {};
      const gate = callerAccess(req, body.shopId, { read: true });
      if (!gate.ok && gate.status === 401) return sendDeny(res, gate);
      const input = parseOr400(schemaOf("ShiftHistoryRequest"), body, res);
      if (!input) return res;
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      if (!hasRight(access, RIGHT)) return sendDeny(res, deny(403, "right_required"));

      const shopSnap = await shopSnapOf(db, access);
      if (!shopSnap.exists) return fail(res, 404, "shop_not_found");
      const shop = shopSnap.data() || {};
      const denied = memberDeny(shop, access);
      if (denied) return sendDeny(res, denied);
      const now = await readNow(deps);
      if (!isPremiumActive(shop, now)) return fail(res, 403, "premium_required");

      const key = shopKey(access.shopId, shop);
      const dates = [...new Set(input.dates)];
      const snap = await db.collection("shiftHistory")
        .where("shopId", "==", key)
        .where("lastShiftDate", "in", dates)
        .get();
      const rows = snap.docs
        .filter((d) => { const x = d.data(); return x && typeof x === "object" && x.shopId === key; })
        .map((d) => ({ ...toClientJson(d.data()), id: d.id }));
      return ok(res, { ...adminFlag(access), history: rows });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { history, RIGHT };
