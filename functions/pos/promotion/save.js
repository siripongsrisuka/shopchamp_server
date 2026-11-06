// pos/promotion/save — สร้างหรือแก้โปรโมชันระดับบิลทั้งก้อน (ก้อน 9b · DEV-0001)
//
// สัญญา: shopchamp-center/api/promotion.save.yaml · คำขอ PromotionSaveRequest (requests/promotion.ts)
// ทางเดิม: W1 `doc.set({...current, id})` ไม่ await (P5) · W2 `update(current)` ทั้งก้อน (`main3:src/redux/promotionSlice.js:15-52`)
//   ด่านเดิมดูแค่ความยาว array ที่จอ (P3) ⇒ ใหม่ประกอบ doc แล้วตรวจด้วย PromotionWrite ที่ server (K04 K06 F09 F32 F34-F36 F41 P10)
//
// ลำดับ:
//   1. callerAccess → 401/403 · PromotionSaveRequest → 400 · สิทธิ์ '101' → 403 (ก่อนอ่านฐาน)
//   2. ประกอบ doc: เนื้อจากคำขอ + {id, shopId: shopField, startDate/endDate เป็น Date, timestamp, updatedAt: now, updatedBy: uid}
//      → PromotionWrite.safeParse · ไม่ผ่าน = 400 invalid_request (issues ชี้ path `promotion.<ช่อง>`)
//   3. transaction: shop (ด่าน _gate + พรีเมี่ยม 403 premium_required) · promotion/{id}
//      create: มีแล้วของร้านนี้ = 200 duplicate (ไม่ทับ) · ของร้านอื่น = 409 promotion_other_shop · ไม่มี = set (timestamp = now)
//      update: ไม่มี 404 promotion_not_found · ร้านอื่น 409 · doc มี updatedAt แต่ baseUpdatedAt ไม่ตรง (หรือไม่ส่ง) = 409 promotion_changed
//        (กันเครื่องค่าเก่าทับ · ไม่มีรหัสบั๊กในไฟล์บั๊ก · เดิมเขียนผิดว่า F39 ซึ่งคือเรื่องโปรผูก id ที่ถูกลบ ยังไม่ปิด)
//        ยกเว้น doc ในฐานเป็นผลของคำขอนี้จากคนเดิมแล้ว (sameContent · ส่งซ้ำหลังสำเร็จ) = 200 duplicate updatedAt เดิม
//        รอยทีมงาน: ทีมงานแก้ = byAdmin adminUid · คนในร้านแก้ต่อ doc ที่รอยเป็นทีมงาน = ล้างเป็น false/null (_gate trailFor)
//        เขียนด้วย update (ช่องอื่นที่แอปเก่าเคยใส่ เช่นรุ่น 1 `slot` `reward` คงอยู่แบบ W2) · timestamp = ค่าเดิม (ไม่มี = now)
//   ⚠️ แอปเก่าแก้ด้วย `update(current)` ที่ส่ง updatedAt ค่าเดิมกลับ ⇒ ด่านเครื่องค่าเก่าจับได้เฉพาะการแก้ผ่าน API ใหม่ด้วยกัน
"use strict";

const { db } = require("../../firebase");
const { PromotionSaveRequest, PromotionWrite } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny, zodIssues } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminTrail, adminFlag, belongsToShop } = require("../_shared/auth");
const { isDeepStrictEqual } = require("util");
const { Refusal, refuse, readShopForWrite, isObj, trailFor } = require("../member/_gate");
const { OTHER_SHOP_MSG, rightDeny, requirePremium, msOf } = require("./_common");

/** buildDoc — doc ที่จะเขียน · timestamp แยกส่ง (create = now · update = ค่าเดิม) · trail แยกส่ง (update ล้างรอยทีมงานเดิมได้) */
function buildDoc(input, { shopField, timestamp, now, access, trail }) {
  const p = input.promotion;
  return {
    ...p,
    startDate: new Date(p.startDate),
    endDate: new Date(p.endDate),
    id: input.id,
    shopId: shopField,
    timestamp,
    updatedAt: now,
    updatedBy: access.uid,
    ...(trail || adminTrail(access)),
  };
}

/**
 * sameContent(cur, input, uid) — doc ในฐานคือผลของคำขอนี้จากคนเดิมแล้วหรือยัง (ส่งซ้ำหลังสำเร็จ · เน็ตหลุดก่อนได้คำตอบ)
 *   ต้อง updatedBy = คนเดิม และทุกช่องในคำขอเท่าค่าในฐาน (วันที่เทียบ ms) ⇒ 200 duplicate แทน 409 promotion_changed (ผลตรวจ 9b ผ6)
 */
function sameContent(cur, input, uid) {
  if (!cur || cur.updatedBy !== uid) return false;
  const p = input.promotion;
  for (const k of Object.keys(p)) {
    if (k === "startDate" || k === "endDate") { if (msOf(cur[k]) !== Date.parse(p[k])) return false; }
    else if (!isDeepStrictEqual(cur[k], p[k])) return false;
  }
  return true;
}

function invalidDoc(res, err) {
  const issues = zodIssues(err).map((i) => ({ ...i, path: i.path ? `promotion.${i.path}` : "promotion" }));
  return sendDeny(res, deny(400, "invalid_request", undefined, { issues }));
}

function save(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(PromotionSaveRequest, body, res);
      if (!input) return;
      const rd = rightDeny(access);
      if (rd) return sendDeny(res, rd);

      const now = await readNow(deps);
      // ตรวจรูป doc ก่อนเข้า transaction ด้วย shopField ชั่วคราว (= doc id) · ประกอบจริงอีกครั้งใน transaction ด้วยค่าจากฐาน
      const pre = PromotionWrite.safeParse(buildDoc(input, { shopField: access.shopId, timestamp: now, now, access }));
      if (!pre.success) return invalidDoc(res, pre.error);

      const promoRef = db.collection("promotion").doc(input.id);
      const out = await db.runTransaction(async (tx) => {
        const { shop, ref, shopField } = await readShopForWrite({ tx, shopDocId: access.shopId, access, now });
        requirePremium(shop, now);
        const snap = await tx.get(promoRef);
        const cur = snap.exists ? snap.data() || {} : undefined;

        if (input.mode === "create") {
          if (cur) {
            if (!belongsToShop(cur.shopId, ref)) refuse(deny(409, "promotion_other_shop", OTHER_SHOP_MSG));
            return { duplicate: true, updatedAt: cur.updatedAt };
          }
          const doc = buildDoc(input, { shopField, timestamp: now, now, access });
          tx.set(promoRef, doc);
          return { duplicate: false, updatedAt: now };
        }

        if (!cur) refuse(deny(404, "promotion_not_found"));
        if (!belongsToShop(cur.shopId, ref)) refuse(deny(409, "promotion_other_shop", OTHER_SHOP_MSG));
        const curMs = msOf(cur.updatedAt);
        if (curMs !== null) {
          const baseMs = input.baseUpdatedAt === undefined ? null : Date.parse(input.baseUpdatedAt);
          if (baseMs !== curMs) {
            if (sameContent(cur, input, access.uid)) return { duplicate: true, updatedAt: cur.updatedAt };
            refuse(deny(409, "promotion_changed", "โปรนี้ถูกแก้จากเครื่องอื่น กรุณาเปิดใหม่แล้วแก้อีกครั้ง"));
          }
        }
        const keepTs = cur.timestamp !== undefined && cur.timestamp !== null ? cur.timestamp : now;
        const doc = buildDoc(input, { shopField, timestamp: keepTs, now, access, trail: trailFor(access, cur) });
        const check = PromotionWrite.safeParse(doc);
        if (!check.success) refuse(deny(400, "invalid_request", undefined, { issues: zodIssues(check.error) }));
        tx.update(promoRef, doc);
        return { duplicate: false, updatedAt: now };
      });

      const ms = msOf(out.updatedAt);
      return ok(res, {
        id: input.id,
        duplicate: out.duplicate,
        updatedAt: ms === null ? null : new Date(ms).toISOString(),
        ...adminFlag(access),
      });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { save, buildDoc, sameContent };
