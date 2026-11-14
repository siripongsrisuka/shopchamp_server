// pos/shop/findByTel — ค้นร้านด้วยเบอร์โทร ก่อนเข้าร้าน (DEV-0010 คลื่น 2 · กลุ่ม shop)
//
// สัญญา: shopchamp-center/api/shop.findByTel.yaml · route POST /pos/shop/find-by-tel (auth user · ยังไม่รู้ร้าน · อ่านอย่างเดียว)
// แทน: `shopchamp_app/src/modal/Modal_FindShop.js:60` (shop where tel == เบอร์ · ไม่ limit · คืน doc ทั้งก้อนให้ทุกบัญชีที่ login)
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/shop/lookup.js:39-71` (byTel · auth user · limit 20 · ช่องน้อย)
//   ต่างจากต้นแบบ: คืนช่องตามหน้าต่างบ้านนี้ {id, shopId, name, logo} · ตัด imageUrl createdDate branchId creatorName providerId vip
// สิทธิ์ (Pack 2026-11-14 ข้อ 9): เท่าแอปเดิม = ทุกบัญชีที่ login กดปุ่ม "ค้นหาร้านค้า" ได้ (`Modal_Shop.js:94`) ⇒ ไม่มีด่านร้าน
// ช่องที่คืน = เท่าที่หน้าต่างใช้จริง (ไล่ตัวแปรในแอป · ไม่ใช่ระบบปกปิด):
//   id    — เลือกแถว `selected.id === id` (Modal_FindShop.js:27) · enterShop รับ doc id
//   name  — ชื่อบนแถว (:31)
//   logo  — รูปบนแถว (:30) · หน้าต่างเดิมคิด `logo || imageUrl[type logo].value || ''` (:66-71) ⇒ server คิดให้แบบเดียวกัน
//   shopId — goToShop ใช้ทำแถว port/currentLogin ในเครื่อง (`WelcomeScreen.js:118-129`) · = field ร้าน ไม่มี = doc id (แบบ enterShop)
//   ❌ humanResource vip imageUrl ฯลฯ: goToShop เดิมใช้ตัดสินสิทธิ์ในเครื่อง แต่ enterShop ที่ server ตัดสินซ้ำแล้ว และคืน shop ก้อนเต็มให้หลังผ่านด่าน
// limit 20 (แบบพี่น้อง · กันดึงทั้ง collection) · ของเดิมไม่ limit ⇒ เบอร์เดียวกันเกิน 20 ร้านเห็นแค่ 20 แรก (❓ ยังไม่ได้นับในฐานว่ามีไหม)
// Firestore อ่าน: shop where tel == X limit 20 (= จำนวนร้านที่ตรง ไม่เกิน 20 · ไม่เกินของเดิม)
// ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { ok, fail, parseOr400, internalError } = require("../_shared/respond");
const { schemaOf } = require("../stock/_shared");

const LIMIT = 20;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");

function logoOf(shop) {
  if (typeof shop.logo === "string" && shop.logo) return shop.logo;
  const img = Array.isArray(shop.imageUrl) ? shop.imageUrl.find((a) => isObj(a) && a.type === "logo") : null;
  return img && typeof img.value === "string" ? img.value : "";
}

function rowOf(id, d) {
  const shop = isObj(d) ? d : {};
  return { id, shopId: str(shop.shopId) || id, name: str(shop.name), logo: logoOf(shop) };
}

function findByTel(_deps) {
  return async function handler(req, res) {
    try {
      const uid = req && req.auth && typeof req.auth.uid === "string" && req.auth.uid ? req.auth.uid : "";
      if (!uid) return fail(res, 401, "no_auth");
      const input = parseOr400(schemaOf("ShopFindByTelRequest"), req.body, res);
      if (!input) return res;
      const snap = await db.collection("shop").where("tel", "==", input.tel).limit(LIMIT).get();
      const shops = snap.docs.filter((d) => isObj(d.data()) && d.data().tel === input.tel).map((d) => rowOf(d.id, d.data()));
      return ok(res, { shops });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { findByTel, LIMIT };
