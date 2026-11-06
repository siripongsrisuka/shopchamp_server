// pos/shopStaff/claimLegacyShop — เข้าครั้งแรกของร้านรุ่นแรก: สร้าง profile เจ้าของ + แถวเจ้าของ + จุดขายแรก + doc กะ ใน transaction เดียว
//   (ก้อน 10 รอบ 2c · DEV-0001 · แถว LD-029)
//
// สัญญา: shopchamp-center/api/profile.claimLegacyShop.yaml · คำขอ ProfileClaimLegacyShopRequest (@shopchamp/schema › requests/claimLegacyShop.ts)
// แทน `app:screens/LoadingScreen.js:156-218` (บัญชีไม่มี profile แต่มีร้านที่ field shopId == uid · แอปเขียนเองทั้ง 3 doc)
// ร้านรุ่นแรก (วัดฐานจริง 2026-11-07 อ่านอย่างเดียว): doc ร้าน 57,407 · shopId ≠ doc id 11,312 · ในนั้นเจ้าของยังไม่มี profile 8,476 ร้าน
//   ทุกร้านในกลุ่มนี้ humanResource ว่าง และ POSs ว่าง · เจ้าของ 39 คนมีร้านแบบนี้มากกว่า 1 ร้าน
//
// ลำดับ: ไม่มี req.auth.uid 401 no_auth → schema 400 → หาร้าน shop where shopId == uid (นอก tx · query ใน tx ฐานปลอมไม่รองรับ)
//   ไม่มี 404 legacy_shop_not_found · หลายร้าน = เลือกตัวสุดท้ายตามลำดับ doc id (แอปเก่า forEach ทับจนตัวสุดท้าย · ลำดับ query ตั้งต้นของ Firestore)
//   tx: profile/{uid} · shop/{เลือก}
//     มี profile แล้ว = 200 claimed:false ไม่เขียน (ส่งซ้ำหลังสำเร็จได้ · แอปเก่าเครื่องอื่นทำไปแล้วก็ได้)
//     ร้านหาย/field shopId ไม่ใช่ uid แล้ว 409 shop_changed · humanResource หรือ POSs ไม่ว่าง 409 shop_already_claimed
//       (แอปเก่าเขียนทับทั้ง 2 ช่อง = ลบพนักงานและจุดขายเดิม · ฐานจริงไม่มีร้านแบบนี้ ⇒ ปัดไว้ ไม่ทับ)
//   เขียน (รูปเดียวกับแอปเก่าทุกช่อง):
//     profile/{uid} set  = initialProfile + {name: shop.ownerName, tel: shop.tel, email: shop.email, timestamp: now,
//                          port: [{position:['001'], shopId, shopName: shop.name, logo}], currentLogin: {shopId, printer: [], rights: ชุดเต็ม}}
//     shift/{auto} set   = (id: deps.newId ถ้าส่ง · ไม่งั้น auto id แบบแอปเก่า) initialShift + {posId, shopId (field ร้าน), id}
//     shop update        = humanResource [แถวเจ้าของ] · POSs [initialPos + {id: posId, name: 'แคชเชียร์ 1', uniqueId, shiftId, deviceName}] · legacyClaimedAt (เพิ่มอย่างเดียว)
//   ต่างจากแอปเก่า (ตั้งใจ): แถวเจ้าของมี status 'active' และ rights ชุดเต็ม (รูปเดียวกับร้านใหม่ shopTemplate.js:181)
//     แอปเก่าไม่ใส่ status ⇒ เปิดแอปครั้งถัดไปด่าน `a.status === 'active'` (LoadingScreen.js:77 · WelcomeScreen.js:138) ไม่ผ่าน = เจ้าของเข้าร้านตัวเองไม่ได้
//     วัดฐานจริง: ร้านรุ่นแรกที่เจ้าของมี profile แล้ว แถวเจ้าของไม่มี status 220 ร้าน · มี 'active' 2,582 ร้าน
// ❌ ห้าม require SDK ตัวจริง · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { ProfileClaimLegacyShopRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow, depOr } = require("../_shared/deps");
const { INITIAL_RIGHTS, OWNER_POSITION } = require("../_shared/auth");
const { initialPos, initialShift } = require("../company/shopTemplate");
const { isObj, Refusal, refuse } = require("./common");

const str = (v) => (typeof v === "string" ? v : "");
const isEmptyList = (v) => v === undefined || v === null || (Array.isArray(v) && v.length === 0);

function logoOf(shop) {
  if (typeof shop.logo === "string" && shop.logo) return shop.logo;
  const img = Array.isArray(shop.imageUrl) ? shop.imageUrl.find((a) => isObj(a) && a.type === "logo") : null;
  return img && typeof img.value === "string" ? img.value : "";
}

function claimLegacyShop(deps) {
  return async function handler(req, res) {
    try {
      const uid = req && req.auth && typeof req.auth.uid === "string" && req.auth.uid ? req.auth.uid : null;
      if (!uid) return sendDeny(res, deny(401, "no_auth"));
      const body = isObj(req && req.body) ? req.body : {};
      const input = parseOr400(ProfileClaimLegacyShopRequest, body, res);
      if (!input) return;

      const now = await readNow(deps);
      const found = await db.collection("shop").where("shopId", "==", uid).get();
      const ids = found.docs.map((d) => d.id).sort();
      if (ids.length === 0) return sendDeny(res, deny(404, "legacy_shop_not_found", "ไม่พบร้านของบัญชีนี้"));
      const shopDocId = ids[ids.length - 1];

      const profileRef = db.collection("profile").doc(uid);
      const shopRef = db.collection("shop").doc(shopDocId);
      const newId = depOr(deps, "newId", null);
      const shiftRef = newId ? db.collection("shift").doc(String(await newId())) : db.collection("shift").doc();

      const out = await db.runTransaction(async (tx) => {
        const [pSnap, sSnap] = await Promise.all([tx.get(profileRef), tx.get(shopRef)]);
        if (pSnap.exists) return { claimed: false };
        if (!sSnap.exists) refuse(deny(409, "shop_changed"));
        const shop = sSnap.data() || {};
        if (shop.shopId !== uid) refuse(deny(409, "shop_changed"));
        if (!isEmptyList(shop.humanResource) || !isEmptyList(shop.POSs)) refuse(deny(409, "shop_already_claimed"));

        const shopId = uid;
        const ownerName = str(shop.ownerName);
        const currentLogin = { shopId, printer: [], rights: [...INITIAL_RIGHTS] };
        tx.set(profileRef, {
          imageId: "",
          timestamp: now,
          name: ownerName,
          tel: str(shop.tel),
          email: str(shop.email),
          gender: "",
          birthday: "",
          port: [{ position: [OWNER_POSITION], shopId, shopName: str(shop.name), logo: logoOf(shop) }],
          currentLogin,
          wallPaper: { status: false, imageId: "" },
        });
        tx.set(shiftRef, { ...initialShift(), posId: input.posId, shopId, id: shiftRef.id });
        tx.update(shopRef, {
          humanResource: [
            { id: uid, position: [OWNER_POSITION], name: ownerName, imageId: "", email: "", tel: "", status: "active", rights: [...INITIAL_RIGHTS] },
          ],
          POSs: [{ ...initialPos(), id: input.posId, name: "แคชเชียร์ 1", uniqueId: input.uniqueId, shiftId: shiftRef.id, deviceName: str(input.deviceName) }],
          legacyClaimedAt: now,
        });
        return { claimed: true, shopDocId, shopId, posId: input.posId, shiftId: shiftRef.id, currentLogin };
      });

      return ok(res, { uid, ...out, ...(ids.length > 1 ? { otherLegacyShops: ids.length - 1 } : {}) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { claimLegacyShop };
