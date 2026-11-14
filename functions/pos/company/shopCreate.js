// pos/company/shopCreate — สร้างร้านใหม่ + เลขร้าน scShopId (ก้อน 9d DEV-0001)
//
// สัญญา: shopchamp-center/api/company.shopCreate.yaml · คำขอ CompanyShopCreateRequest (@shopchamp/schema)
// แทน: main3 src/screens/NewShopScreen.js:40-157 (transaction ในแอป: shopchamShopId/numOfStore +1 · shop · shift · profile)
// ยังไม่ export จาก index.js และยังไม่ deploy · route auth 'user' (ยังไม่มีร้าน)
//
// ลำดับ:
//   1. ไม่มี req.auth.uid 401 no_auth · รูปคำขอ 400
//   2. doc id ร้านและกะคิดจาก (uid, requestId) แบบคงที่ ⇒ ส่งซ้ำ/SDK ลองซ้ำได้ร้านเดิม ไม่ได้ร้านที่ 2 (shopchamShopId B7 B9)
//   3. transaction อ่าน: shopchamShopId/numOfStore · shop/{id} · shift/{id} · profile/{uid}
//      shop มีแล้วและสร้างโดยคำขอนี้ (createRequestId ตรง และเจ้าของ = ผู้เรียก) = 200 duplicate (posId = POSs[0].id ของร้านเดิม) · มีแต่ไม่ใช่ = 409 request_id_conflict
//      profile ไม่มี 404 profile_not_found · ตัวนับไม่มี 500 counter_missing (B3 ไม่สร้างเอง: เลขร้านต้องต่อจากของเดิม)
//      total ไม่ใช่จำนวนเต็ม ≥ 0 = 500 counter_broken (B4)
//   4. เขียน (รูปเดิมทุก field · shopTemplate.js เทียบกับ main3 ในเทส):
//      shop/{id} ทั้งก้อน + createRequestId · createdVia · shift/{id} · numOfStore.total = scShopId · profile {port:[...port, ใหม่], currentLogin}
// คำตอบ (DEV-0010 ของเพิ่ม · แอปเก่าไม่อ่าน): shop = ก้อนร้านแบบ shop.get (shop/_appView.js) · profile = {port, currentLogin} หลังเขียน
//   แทนการอ่าน shop/{id} + profile/{uid} หลังสร้าง (`NewShopScreen.js:68-69`) · ส่งซ้ำ (duplicate) = ของในฐานตอนนั้น · 0 อ่านเพิ่ม
// push ต้อนรับ (DEV-0001 push): หลัง commit (ไม่ใช่ duplicate) ส่งหาผู้สร้าง (uid · ทุกร้าน) ทั้ง 2 ท่อ
//   แอปเก่าส่งทั้งร้านใหม่ (NewShopScreen.js:83 pushByOneFilter shopId) · ร้านเพิ่งเกิดยังไม่มีเครื่องลงทะเบียน ⇒ ส่งหาคนสร้างแทน (เครื่องเดียวกัน)
"use strict";

const crypto = require("crypto");
const { db } = require("../../firebase");
const { CompanyShopCreateRequest } = require("@shopchamp/schema");
const { ok, fail, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { buildNewShop } = require("./shopTemplate");
const { notify } = require("../_shared/push/notify");
const { appShopView } = require("../shop/_appView");
const { toPlain } = require("../profile/loading");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** doc id 20 ตัวแบบ auto id ของ Firestore · คงที่ต่อ (ชนิด, uid, requestId) */
function derivedId(kind, uid, requestId) {
  const h = crypto.createHash("sha256").update(`${kind}\u0000${uid}\u0000${requestId}`, "utf8").digest();
  let out = "";
  for (let i = 0; i < 20; i++) out += ALPHABET[h[i] % ALPHABET.length];
  return out;
}

/** profileOut(port, currentLogin) — ช่อง profile ที่จอสร้างร้านใช้ (`NewShopScreen.js:74-75`) · เวลาเป็น ISO */
function profileOut(port, currentLogin) {
  return {
    port: Array.isArray(port) ? toPlain(port) : [],
    currentLogin: currentLogin && typeof currentLogin === "object" ? toPlain(currentLogin) : { shopId: "", rights: [], printer: [] },
  };
}

class Refusal extends Error {
  constructor(d) { super(d.error); this.deny = d; }
}
const refuse = (d) => { throw new Refusal(d); };

function shopCreate(deps) {
  return async function handler(req, res) {
    try {
      const uid = req && req.auth && typeof req.auth.uid === "string" && req.auth.uid !== "" ? req.auth.uid : "";
      if (!uid) return fail(res, 401, "no_auth");
      const input = parseOr400(CompanyShopCreateRequest, req.body, res);
      if (!input) return;
      const now = await readNow(deps);

      const shopDocId = derivedId("shop", uid, input.requestId);
      const shiftId = derivedId("shift", uid, input.requestId);
      const counterRef = db.collection("shopchamShopId").doc("numOfStore");
      const shopRef = db.collection("shop").doc(shopDocId);
      const shiftRef = db.collection("shift").doc(shiftId);
      const profileRef = db.collection("profile").doc(uid);

      const out = await db.runTransaction(async (tx) => {
        const [counterSnap, shopSnap, profileSnap] = await Promise.all([tx.get(counterRef), tx.get(shopRef), tx.get(profileRef)]);
        if (shopSnap.exists) {
          const s = shopSnap.data() || {};
          const owner = Array.isArray(s.humanResource) && s.humanResource[0] ? s.humanResource[0].id : undefined;
          if (s.createRequestId === input.requestId && owner === uid) {
            // คืนเครื่องแรกของร้านที่สร้างไว้แล้ว ไม่ใช่ posId ของคำขอที่ส่งซ้ำ (ตรวจซ้ำ 9d ข้อสังเกต)
            const pos0 = Array.isArray(s.POSs) && s.POSs[0] && typeof s.POSs[0].id === "string" && s.POSs[0].id !== "" ? s.POSs[0].id : null;
            // DEV-0010: ก้อนร้าน + profile ที่อ่านใน transaction แล้ว (0 อ่านเพิ่ม)
            const p = profileSnap.exists ? profileSnap.data() || {} : {};
            return { duplicate: true, scShopId: s.scShopId, posId: pos0, shop: appShopView(shopDocId, s), profile: profileOut(p.port, p.currentLogin) };
          }
          refuse(deny(409, "request_id_conflict", "รหัสคำขอนี้ถูกใช้แล้ว"));
        }
        if (!profileSnap.exists) refuse(deny(404, "profile_not_found", "ไม่พบข้อมูลบัญชี"));
        if (!counterSnap.exists) refuse(deny(500, "counter_missing", "ระบบออกเลขร้านไม่ได้ กรุณาติดต่อทีมงาน"));
        const total = (counterSnap.data() || {}).total;
        if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(total + 1)) {
          refuse(deny(500, "counter_broken", "ระบบออกเลขร้านไม่ได้ กรุณาติดต่อทีมงาน"));
        }
        const scShopId = total + 1;
        const profile = profileSnap.data() || {};
        const built = buildNewShop({ shopDocId, shiftId, uid, profile, input, scShopId, now });
        const port = Array.isArray(profile.port) ? profile.port : [];

        tx.set(shopRef, built.shop);
        tx.set(shiftRef, built.shift);
        tx.update(counterRef, { total: scShopId });
        tx.update(profileRef, { port: [...port, built.port], currentLogin: built.currentLogin });
        return {
          duplicate: false,
          scShopId,
          shop: appShopView(shopDocId, built.shop),
          profile: profileOut([...port, built.port], built.currentLogin),
        };
      });
      if (!out.duplicate) {
        await notify(deps, { to: { kind: "people", ids: [uid] }, heading: "สร้างร้านค้าสำเร็จ!", content: "ยินดีต้อนรับ เข้าสู่ครอบครัว ช็อปแชมป์ ระบบใช้งานง่าย ตอบโจทย์ร้านค้าค่ะ" });
      }
      return ok(res, {
        shopId: shopDocId, shiftId, posId: out.posId || input.posId, scShopId: out.scShopId, duplicate: out.duplicate,
        shop: out.shop, profile: out.profile,
      });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { shopCreate, derivedId };
