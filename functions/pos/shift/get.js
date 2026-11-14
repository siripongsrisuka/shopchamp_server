// pos/shift/get — เอกสารกะ 1 ใบของจุดขาย (DEV-0010 คลื่น 2 · กลุ่ม bill/shift)
//
// สัญญา: shopchamp-center/api/shift.get.yaml · route POST /pos/shift/get (auth shop · อ่านอย่างเดียว)
// แทน: `shopchamp_app/src/screens/HomeScreen.js:626` (get ก่อนเข้าจอแคชเชียร์) · listener `ShiftScreen.js:142` · `CheckoutScreen.js:199`
//   Pack 2026-11-14 ข้อ 2: เลิก listener กะ · อ่านผ่าน shift.get ตอนเข้าจอ/หลังทุก op · จอคิดเงินอ่านจาก MMKV
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง `functions/claude/shift/fetchCurrent.js:13-17` (doc เต็ม ไม่ whitelist · `{...doc, id}`)
//   ต่างจากต้นแบบ: อ่านใบเดียวตาม shiftId (บ้านนี้ shiftId ผูกจุดขายอยู่แล้ว) แทน where shopId ทุกจุด ⇒ ค่าอ่านไม่โตตามจำนวนจุด
// คำตอบ: {ok, shift:{...doc ทุกช่อง · เวลาเป็น ISO · id = doc id}, byAdmin?}
//   doc เต็มเหมือนที่แอปอ่านเอง (จอกะใช้ status lastShiftDate shiftCount openName openTime openCash duringShift ·
//   กะที่ปิดแล้วยังมี lastShiftDate shiftCount ของรอบล่าสุด = จอนับกะถัดไปได้) · ไม่เติมค่าตั้งต้น (แอปทำ {...initialShift, ...doc} เอง)
// ด่าน: requireShopAccess → callerAccess อ่านอย่างเดียว (watcher ผ่าน) → ด่านซ้ำสมาชิก active
//   ไม่มีเลขสิทธิ์ (Pack ข้อ 9): แคชเชียร์ทั่วไปต้องรู้ว่ากะของจุดตัวเองเปิดไหมก่อนขาย (HomeScreen.js:622 ไม่ตรวจสิทธิ์)
// ของร้านไหม: doc.shopId ตรง doc id ร้าน หรือช่อง shopId ของ doc ร้านที่ผ่านด่านแล้ว (Pack ข้อ 8) · ไม่ตรง 409 shift_other_shop · ไม่มี 404 shift_not_found
// Firestore อ่าน: shop/{shopId} · shift/{shiftId} (+1 ของ middleware) · เขียน: ไม่มี
// ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { ok, fail, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { callerAccess, adminFlag } = require("../_shared/auth");
const { schemaOf } = require("../stock/_shared");
const { memberDeny } = require("../shop/_appView");
const { toClientJson } = require("../sale/getSerialize");

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
/** ค่าค้น/ค่าเทียบของร้าน = ช่อง shopId ของ doc ร้าน · ไม่มี = doc id (Pack ข้อ 8) */
const shopKey = (shopDocId, shop) => (typeof shop.shopId === "string" && shop.shopId !== "" ? shop.shopId : shopDocId);

function get(_deps) {
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
        db.collection("shop").doc(access.shopId).get(),
        db.collection("shift").doc(input.shiftId).get(),
      ]);
      if (!shopSnap.exists) return fail(res, 404, "shop_not_found");
      const shop = shopSnap.data() || {};
      const denied = memberDeny(shop, access);
      if (denied) return sendDeny(res, denied);

      const d = shiftSnap && shiftSnap.exists ? shiftSnap.data() : undefined;
      if (!isObj(d)) return fail(res, 404, "shift_not_found");
      const owner = typeof d.shopId === "string" && d.shopId !== "" && (d.shopId === access.shopId || d.shopId === shopKey(access.shopId, shop));
      if (!owner) return fail(res, 409, "shift_other_shop");
      return ok(res, { ...adminFlag(access), shift: { ...toClientJson(d), id: input.shiftId } });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { get, shopKey };
