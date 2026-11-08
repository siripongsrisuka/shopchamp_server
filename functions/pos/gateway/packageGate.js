// pos/gateway/packageGate.js — แพ็กเกจ Payment Gateway (`shop.vip[]` แถว type 'gateway') ตัดสินที่ server (DEV-0001 · Pack เคาะ 2a 2026-11-08)
//
// กติกา: ร้านที่ไม่มีแพ็กเกจ gateway ที่ยังไม่หมดอายุ = ใช้เส้นที่ "เริ่ม/ตั้งค่า" การรับเงินออนไลน์ไม่ได้ → 403 package_required
//   ตัดสินด้วย `_shared/premium.js › vipActive(shop, 'gateway', now)` (กติกาวันเดียวกับ handleShop ของแอป · ทั้งวันหมดอายุยังใช้ได้)
//   ไม่มีร้านไหนใช้เกตเวย์ในแอปเก่า (Pack ยืนยัน 2026-11-08) ⇒ ไม่มีข้อยกเว้นร้านเดิม
// เส้นไหนติดด่าน = ช่อง pkg ของทะเบียน gateway/routes.js (เทส routes.test.js บังคับให้ทุกเส้นแอปประกาศ)
//
// ที่มาของ doc ร้าน (อ่าน shop/{shopId} ไม่เกิน 1 ครั้งต่อคำขอ):
//   ① ด่าน requireShopAccess ของ pos_gateway อ่าน shop/{shopId} อยู่แล้ว ⇒ routes.js ฝากข้อมูลไว้บน req.shopAccess ด้วยกุญแจ Symbol
//      (ไม่ enumerable · ไม่ออกทาง JSON · ผู้เรียกส่งมาทาง body/header ไม่ได้ เพราะ JSON สร้าง Symbol ไม่ได้)
//   ② ไม่มีของฝาก (harness/เทสส่ง req.shopAccess มาเอง) = อ่าน shop/{shopId} 1 ครั้ง · ไม่มี doc = ถือว่าไม่มีแพ็กเกจ (fail-closed)
// นาฬิกา: now ของ handler (readNow(deps) ครั้งเดียวต่อคำขอ) ไม่ใช่นาฬิกาของด่าน
"use strict";

const { vipActive } = require("../_shared/premium");
const { fail } = require("../_shared/respond");

const PACKAGE_TYPE = "gateway";
const SHOP_DATA = Symbol.for("shopchamp.pos_gateway.shopData");
const PACKAGE_MESSAGE = "ร้านยังไม่มีแพ็กเกจ Payment Gateway หรือแพ็กเกจหมดอายุแล้ว — ซื้อหรือต่ออายุแพ็กเกจก่อนใช้รับเงินออนไลน์";

/** ฝาก doc ร้านที่ด่านอ่านแล้วไว้บน access (คืน access ตัวเดิม) */
function attachShopData(access, data) {
  if (access && typeof access === "object") {
    Object.defineProperty(access, SHOP_DATA, { value: data && typeof data === "object" ? data : {}, enumerable: false, configurable: true });
  }
  return access;
}

/** doc ร้าน: ของฝากจากด่าน หรืออ่าน shop/{shopId} 1 ครั้ง · ไม่มี doc = null */
async function shopDataOf({ db, access }) {
  if (access && Object.prototype.hasOwnProperty.call(access, SHOP_DATA)) return access[SHOP_DATA];
  const snap = await db.collection("shop").doc(access.shopId).get();
  return snap && snap.exists ? snap.data() || {} : null;
}

/** gatewayPackageActive({db, access, now}) → boolean */
async function gatewayPackageActive({ db, access, now }) {
  const shop = await shopDataOf({ db, access });
  return vipActive(shop, PACKAGE_TYPE, now);
}

/** ตอบ 403 package_required */
function packageRequired(res) {
  return fail(res, 403, "package_required", PACKAGE_MESSAGE, { package: PACKAGE_TYPE });
}

/**
 * passesPackage({db, access, now, res}) → true = ผ่าน · false = ตอบ 403 package_required ไปแล้ว
 *   handler เรียกหลังด่านสิทธิ์/รูปคำขอ และก่อนแตะผู้ให้บริการหรือเขียนฐาน · อ่านฐานล้ม = throw ให้ catch ของ handler ตอบ 500
 */
async function passesPackage({ db, access, now, res }) {
  if (await gatewayPackageActive({ db, access, now })) return true;
  packageRequired(res);
  return false;
}

module.exports = { passesPackage, PACKAGE_TYPE, PACKAGE_MESSAGE, SHOP_DATA, attachShopData, shopDataOf, gatewayPackageActive, packageRequired };
