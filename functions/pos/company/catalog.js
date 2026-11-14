// pos/company/catalog — ตารางแพ็กเกจ/อุปกรณ์ของบริษัท ให้จอร้าน (DEV-0010 คลื่น 2 · กลุ่ม shop/system)
//
// สัญญา: shopchamp-center/api/company.catalog.yaml · route POST /pos/company/catalog (auth shop · อ่านอย่างเดียว)
// แทน: `shopchamp_app/src/screens/PackageScreen.js:41` (admin/package) · `shopchamp_app/src/screens/HardwareScreen.js:99` (admin/hardware)
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง `functions/claude/admin/get.js:73-105` (อ่าน admin/{docId} ตามรายการที่อนุญาต)
//   ต่างจากต้นแบบ: ส่งเฉพาะช่องที่จอใช้ (ต้นแบบคืนทั้ง doc) · ❌ ช่อง `admin` = uid ทีมงานที่รับ push (`company/_orders.js:20-21`) ไม่ออก
//   ช่องที่จอใช้ (ไล่ตัวแปรในแอป 2026-11-14):
//     package : value (visiblePackagesOf) · payment · packageLink (`PackageScreen.js:43-48`) · admin ส่งต่อ PayScreen แต่ไม่ใช้ (`PayScreen.js:48`)
//     hardware: value · categories (companyHardwareGroups) · shipping (companyHardwareShipping) (`HardwareScreen.js:101-106`)
//               admin ส่งต่อ HardwareSummaryScreen แต่ไม่มีใครอ่าน (`HardwareSummaryScreen.js:51`)
// สิทธิ์ (Pack 2026-11-14 ข้อ 9 · เท่าที่แอปเปิดตอนนี้):
//   package : สมาชิกทุกคน · จอเปิดได้จากไทล์ 104 และจากป๊อปอัป "อัปเกรด/เพิ่มวันใช้งาน" ที่ทุกคนเห็น (`HomeScreen.js:381,481,495` · `PayScreen.js:87`)
//   hardware: สิทธิ์ '105' (ไทล์ 105 ทางเดียว `HomeScreen.js:85`) · เจ้าของ/ทีมงานผ่าน
//   (ไทล์ 104/105 ถูกซ่อนเมื่อ isPackageOn ปิด = ค่าตั้งแอปจาก admin/updateShopchamp ไม่ใช่สิทธิ์คน ⇒ server ไม่ตรวจ)
// doc ไม่มี = 200 catalog:null (จอเดิมไม่ตั้งค่าอะไรเมื่อ doc ไม่มี)
// Firestore อ่าน: shop 1 ครั้ง (ด่าน requireShopAccess · handler ใช้ doc ที่ด่านแนบ shopSnapOf ไม่อ่านซ้ำ) · admin/{kind} 1 doc
// ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { ok, fail, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { callerAccess, adminFlag, hasRight, shopSnapOf } = require("../_shared/auth");
const { schemaOf } = require("../stock/_shared");
const { toPlain } = require("../profile/loading");
const { memberDeny } = require("../shop/_appView");

const FIELDS = Object.freeze({
  package: Object.freeze(["value", "payment", "packageLink"]),
  hardware: Object.freeze(["value", "categories", "shipping"]),
});
const RIGHT = Object.freeze({ hardware: "105" });

function catalogView(kind, data) {
  const out = {};
  for (const f of FIELDS[kind]) if (data[f] !== undefined) out[f] = toPlain(data[f]);
  return out;
}

function catalog(_deps) {
  return async function handler(req, res) {
    try {
      const body = req && req.body && typeof req.body === "object" ? req.body : {};
      const gate = callerAccess(req, body.shopId, { read: true });
      if (!gate.ok && gate.status === 401) return sendDeny(res, gate);
      const input = parseOr400(schemaOf("CompanyCatalogRequest"), body, res);
      if (!input) return res;
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const need = RIGHT[input.kind];
      if (need && !hasRight(access, need)) return sendDeny(res, deny(403, "right_required"));

      const [shopSnap, docSnap] = await Promise.all([
        shopSnapOf(db, access),
        db.collection("admin").doc(input.kind).get(),
      ]);
      if (!shopSnap.exists) return fail(res, 404, "shop_not_found");
      const denied = memberDeny(shopSnap.data() || {}, access);
      if (denied) return sendDeny(res, denied);
      const data = docSnap.exists ? docSnap.data() : null;
      const view = data && typeof data === "object" ? catalogView(input.kind, data) : null;
      return ok(res, { ...adminFlag(access), kind: input.kind, catalog: view });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { catalog, FIELDS };
