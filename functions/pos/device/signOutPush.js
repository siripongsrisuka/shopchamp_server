// pos/device/signOutPush — เครื่องนี้เลิกรับแจ้งเตือนของร้าน/บัญชี (DEV-0001 push · แอปรุ่นใหม่ไม่มี OneSignal)
//
// สัญญา: shopchamp-center/api/device.signOutPush.yaml · route POST /pos/device/sign-out-push (auth user · factory · deps: now)
// คำขอ: DeviceSignOutPushRequest = {deviceKey, scope:'shop'|'all'} · แอปเรียกก่อน sign out ของ Firebase (ต้องมี token)
//   scope 'shop' = ออกร้าน (แทน onesignalHandleGetOutShopPlayer) → shopId:null
//   scope 'all'  = ออกจากระบบ (แทน onesignalHandleSignOutUser) → staffId:null shopId:null signedOutAt
// ลำดับ: ไม่มี req.auth.uid 401 no_auth → schema 400 → transaction อ่าน pushDevices/<id>
//   ไม่มี doc / doc เป็นของบัญชีอื่น (staffId ≠ uid) = 200 {cleared:false} ไม่เขียน (ไม่บอกว่ามีเครื่องของคนอื่น · คนอื่นล้างเครื่องเราไม่ได้)
//   ล้างแล้ว = 200 {cleared:true} · เรียกซ้ำหลังล้าง = staffId ไม่ตรงแล้ว ⇒ cleared:false (scope all) · scope shop ซ้ำ = เขียนซ้ำค่าเดิม
"use strict";

const { db } = require("../../firebase");
const { DeviceSignOutPushRequest } = require("@shopchamp/schema");
const { ok, fail, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { COLLECTION, deviceIdOf } = require("../_shared/push/tokenStore");

function signOutPush(deps) {
  return async function handler(req, res) {
    const uid = req && req.auth && typeof req.auth.uid === "string" && req.auth.uid ? req.auth.uid : null;
    if (!uid) return fail(res, 401, "no_auth");
    const input = parseOr400(DeviceSignOutPushRequest, req && req.body, res);
    if (!input) return undefined;
    try {
      const now = await readNow(deps);
      const ref = db.collection(COLLECTION).doc(deviceIdOf(input.deviceKey));
      const cleared = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const cur = snap.exists ? snap.data() || {} : null;
        if (!cur || cur.staffId !== uid) return false;
        tx.update(ref, input.scope === "all"
          ? { staffId: null, shopId: null, signedOutAt: now, updatedAt: now }
          : { shopId: null, updatedAt: now });
        return true;
      });
      return ok(res, { cleared });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { signOutPush };
