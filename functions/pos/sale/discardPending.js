// pos/sale/discardPending — เก็บร่องรอยเมื่อเจ้าของลบบิลที่ค้างส่งในเครื่อง (ก้อน 4 · DEV-0001)
//
// สัญญา: shopchamp-center/api/sale.discardPending.yaml · route POST /pos/sale/discard-pending (ยังไม่ผูก index.js · ยังไม่ deploy)
// รูป: factory (deps) => handler(req, res) · deps: now · now() ไม่ส่ง = new Date()
// ❌ ห้าม require SDK ตัวจริงตรงนี้ (harness ปัดถ้าโหลด firebase-admin) · ใช้ ../../firebase เท่านั้น
//
// ลำดับ:
//   ① callerAccess → 401 no_shop_access / 403 wrong_shop
//   ② ไม่ใช่เจ้าของ (ทีมงาน byAdmin ได้ role owner) → 403 owner_required
//   ③ Zod SaleDiscardPendingRequest → 400 invalid_request
//   ④ transaction (อ่านครบก่อนเขียน): shop/{shopId} · pendingDiscard/{uuid} · receiptGuard/{uuid} · bill/{usedBy} เฉพาะ guard รูปแอปเก่า
//      ร่องรอยหรือ guard เป็นของร้านอื่น → 409 receipt_uuid_other_shop (ไม่คืนอะไร)
//      guard ของร้านนี้ → 409 already_synced {billId, receiptNumber} (แอปเปลี่ยนแถวเป็น synced · S-04)
//      ร่องรอยของร้านนี้มีแล้ว → 200 duplicate:true
//      ไม่มีทั้งคู่ → เขียน pendingDiscard/{uuid} → 200 duplicate:false
// แอปเก่า: ไม่เห็นอะไรเปลี่ยน (collection ใหม่ · ไม่แตะบิล กะ ยอด หรือ receiptGuard)
"use strict";

const { SaleDiscardPendingRequest } = require("@shopchamp/schema");
const { ok, fail, deny, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, isOwner, adminTrail, adminFlag, resolveShopRef } = require("../_shared/auth");
const { discardDoc, decide } = require("./discardPendingDoc");

const DISCARD_COLLECTION = "pendingDiscard";

function discardPending(deps) {
  return async function handler(req, res) {
    const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

    const gate = callerAccess(req, body.shopId);
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;
    if (!isOwner(access)) return sendDeny(res, deny(403, "owner_required"));

    const input = parseOr400(SaleDiscardPendingRequest, body, res);
    if (!input) return undefined;

    try {
      const now = await readNow(deps);
      const { db } = require("../../firebase");
      const uuid = input.receiptUUID;
      const shopRef = db.collection("shop").doc(access.shopId);
      const discardRef = db.collection(DISCARD_COLLECTION).doc(uuid);
      const guardRef = db.collection("receiptGuard").doc(uuid);

      const result = await db.runTransaction(async (tx) => {
        const [shopSnap, discardSnap, guardSnap] = [await tx.get(shopRef), await tx.get(discardRef), await tx.get(guardRef)];
        if (!shopSnap.exists) return { kind: "shop_not_found" };
        const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop: shopSnap.data() });
        const seen = {
          receiptUUID: uuid,
          shopRef: ref,
          discard: discardSnap.exists ? discardSnap.data() : null,
          guard: guardSnap.exists ? guardSnap.data() : null,
        };
        let d = decide(seen);
        if (d.kind === "need_bill") {
          const billSnap = await tx.get(db.collection("bill").doc(d.billId));
          d = decide({ ...seen, billOfGuard: billSnap.exists ? billSnap.data() : null });
        }
        // body ที่เก็บ = ตัวที่เครื่องส่งมาตรงตัว ไม่ใช่สำเนาของ Zod (z.record ทิ้ง key `__proto__` เงียบ ⇒ ร่องรอยไม่ตรงของจริง)
        //   Zod ตรวจแล้วว่าเป็น object ไม่ใช่ array · key ต้องห้ามของ Firestore ไปลง bodyJson ใน discardPendingDoc
        if (d.kind === "write") tx.set(discardRef, discardDoc({ input: { ...input, body: body.body }, access, now, trail: adminTrail(access) }));
        return d;
      });

      switch (result.kind) {
        case "write":
          return ok(res, { discardId: uuid, duplicate: false, ...adminFlag(access) });
        case "duplicate":
          return ok(res, { discardId: uuid, duplicate: true, ...adminFlag(access) });
        case "synced":
          return fail(res, 409, "already_synced", "บิลนี้ส่งขึ้นระบบแล้ว ลบไม่ได้", {
            billId: result.billId,
            receiptNumber: result.receiptNumber,
          });
        case "other_shop":
          return sendDeny(res, deny(409, "receipt_uuid_other_shop"));
        case "shop_not_found":
          return sendDeny(res, deny(404, "shop_not_found"));
        default:
          return internalError(res, new Error(`discardPending: ผลที่ไม่รู้จัก ${result && result.kind}`));
      }
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { discardPending, DISCARD_COLLECTION };
