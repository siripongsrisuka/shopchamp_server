// pos/shopStaff/shopMigrateLegacy — ย้ายโครงร้านรุ่นแรก (ช่อง payment) เป็นโครงปัจจุบัน ครั้งเดียว (ก้อน 10 รอบ 2a · DEV-0001 · U20)
//
// สัญญา: shopchamp-center/api/shop.migrateLegacy.yaml · คำขอ ShopMigrateLegacyRequest (@shopchamp/schema › requests/posManage.ts)
// แทน: `main3:src/screens/HomeScreen.js:326-468` handleNewStructure (เปิดหน้าแรกทุกครั้ง · ทำเมื่อ shop.payment ยาว > 0)
//   แอปเก่าคิดจาก redux แล้วเขียน 6 ช่องทั้งก้อน (POSs shopchampPayment receipt shift payment:[] humanResource)
//   ⇒ ที่นี่คิดสูตรเดียวกันจาก doc ในฐานใน transaction (ไม่เชื่อค่าร้านจากแอป) · แอปส่งแค่ค่าเครื่องพิมพ์ของเครื่องนี้
//
// สูตร (ทีละบรรทัดของต้นฉบับ):
//   POSs[i]          = {...แถวเดิม, printerType, printerBluetooth, printerSize (จากคำขอ), printerUsb ว่าง,
//                       printerEthernet = shop.printers[id == แถว.printerId].ipAddress || ''}   (:376-386)
//   shopchampPayment = เงินสด(1) พร้อมเพย์(2) เงินเซ็น(3) mortal · เปิดตาม payment id '001' '009' '035' · '037' = เพิ่มบัตรสวัสดิการ(4) (:389-437)
//   receipt          = {...receipt เดิม, footerStatus, footer (จาก receiptPay)} + promptpay* เมื่อมี '009' + footerImage เมื่อมี '036' (:416-452)
//   shift            = มีแถวไหน drawer จริง (:461) · payment = [] (:462) · humanResource[0].rights = สิทธิ์เต็มชุด (:463-470)
// ต่างจากต้นฉบับ (ตั้งใจ · ไม่เปลี่ยนผลของร้านที่ข้อมูลครบ):
//   ค่าที่ต้นฉบับได้ undefined (receiptPay ไม่มี footer/status · printer ไม่มี ipAddress) = ใส่ '' / false แทน
//     (ต้นฉบับส่ง undefined เข้า Firestore = ทั้งคำสั่งล้ม ร้านย้ายไม่ได้ทุกครั้งที่เปิด) · ❓ ยังไม่ได้นับร้านที่เป็นแบบนี้
//   ไม่มี payment หรือว่างแล้ว = 200 changed:false ไม่เขียน (2 เครื่องเปิดพร้อมกัน เครื่องหลังไม่ทับ)
// สิทธิ์: คนในร้านทุกคนที่ active (แอปเก่าทำให้ทุกคนที่เปิดหน้าแรก) · ไม่ต้องมีรหัสสิทธิ์
// คำตอบไม่คืน humanResource (มีรหัสแคชเชียร์) · คืน ownerRights {id, rights} ให้แอปทับใน redux เอง
// ❌ ห้าม require SDK ตัวจริง · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { ShopMigrateLegacyRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminFlag, INITIAL_RIGHTS } = require("../_shared/auth");
const { isObj, Refusal, refuse, callerStillActive, toIsoDeep } = require("./common");

const strOr = (v) => (typeof v === "string" ? v : "");

/** migrate(shop, printer) → ค่าใหม่ 6 ช่อง (pure) · ไม่มี payment = null */
function migrate(shop, printer) {
  const payment = Array.isArray(shop.payment) ? shop.payment : [];
  if (payment.length === 0) return null;
  const has = (id) => payment.some((a) => isObj(a) && a.id === id);
  const find = (id) => payment.find((a) => isObj(a) && a.id === id);
  const printers = Array.isArray(shop.printers) ? shop.printers : [];

  const POSs = (Array.isArray(shop.POSs) ? shop.POSs : []).map((a) => {
    const pid = (isObj(a) && a.printerId) || "";
    const hit = printers.find((p) => isObj(p) && p.id === pid);
    return {
      ...(isObj(a) ? a : {}),
      printerType: printer.printerType,
      printerBluetooth: printer.printerBluetooth,
      printerEthernet: (hit && hit.ipAddress) || "",
      printerUsb: { vendor_id: "", product_id: "", device_name: "" },
      printerSize: printer.printerSize,
    };
  });

  let shopchampPayment = [
    { id: 1, name: "เงินสด", mortal: true, status: false },
    { id: 2, name: "พร้อมเพย์", mortal: true, status: false },
    { id: 3, name: "เงินเซ็น", mortal: true, status: false },
  ];
  const turnOn = (id) => { shopchampPayment = shopchampPayment.map((a) => (a.id === id ? { ...a, status: true } : a)); };
  const receiptPay = shop.receiptPay === undefined ? { status: false, paymentId: "", footer: "" } : isObj(shop.receiptPay) ? shop.receiptPay : {};
  const receipt = { ...(isObj(shop.receipt) ? shop.receipt : {}) };

  if (has("001")) turnOn(1);
  const qr = find("009");
  if (qr) {
    turnOn(2);
    receipt.promptpayStatus = receiptPay.paymentId === "009";
    receipt.promptpayId = qr.promptpayId || "";
  }
  if (has("035")) turnOn(3);
  if (has("037")) shopchampPayment.push({ id: 4, name: "บัตรสวัสดิการ", mortal: false, status: true });
  const qr2 = find("036");
  if (qr2) receipt.footerImage = { status: receiptPay.paymentId === "036", imageId: qr2.imageId || "" };
  receipt.footerStatus = receiptPay.status === undefined ? false : receiptPay.status;
  receipt.footer = receiptPay.footer === undefined ? "" : receiptPay.footer;

  const hr = Array.isArray(shop.humanResource) ? shop.humanResource : [];
  const humanResource = hr.map((a, i) => (i === 0 && isObj(a) ? { ...a, rights: [...INITIAL_RIGHTS] } : a));

  return { POSs, shopchampPayment, receipt, shift: POSs.some((a) => !!(a && a.drawer)), payment: [], humanResource };
}

function shopMigrateLegacy(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(ShopMigrateLegacyRequest, body, res);
      if (!input) return;

      const now = await readNow(deps);
      const shopRef = db.collection("shop").doc(access.shopId);
      const out = await db.runTransaction(async (tx) => {
        const snap = await tx.get(shopRef);
        if (!snap.exists) refuse(deny(404, "shop_not_found"));
        const shop = snap.data() || {};
        const inactive = callerStillActive(shop, access, now);
        if (inactive) refuse(inactive);
        const next = migrate(shop, input.printer);
        if (!next) return null;
        const fields = Object.keys(next);
        const trail = { at: now, by: access.uid, fields, migratedLegacy: true };
        if (access.byAdmin === true) { trail.byAdmin = true; trail.adminUid = access.uid; }
        tx.update(shopRef, { ...next, settingsUpdate: trail });
        return next;
      });

      if (!out) return ok(res, { changed: false, ...adminFlag(access) });
      const owner = out.humanResource[0];
      const values = { ...out };
      delete values.humanResource; // มีรหัสแคชเชียร์ ไม่คืนให้แอป
      return ok(res, {
        changed: true,
        values: toIsoDeep(values),
        ownerRights: isObj(owner) ? { id: strOr(owner.id), rights: owner.rights } : null,
        ...adminFlag(access),
      });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { shopMigrateLegacy, migrate };
