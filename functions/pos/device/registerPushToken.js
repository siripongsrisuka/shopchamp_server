// pos/device/registerPushToken — ลงทะเบียนเครื่องรับแจ้งเตือนของแอปรุ่นใหม่ (DEV-0001 push · แอป 5.00.00 ไม่มี OneSignal · Pack เคาะ 2026-11-07)
//
// สัญญา: shopchamp-center/api/device.registerPushToken.yaml · route POST /pos/device/register-push-token (auth shop · factory · deps: now)
// คำขอ: DeviceRegisterPushTokenRequest (@shopchamp/schema) = {shopId, deviceKey, pushToken, platform, appVersion?, model?}
// ลำดับ: schema 400 → callerAccess 401/403 (watcher อ่านอย่างเดียว = 403 watcher_read_only) → transaction อ่าน pushDevices/<id> → เขียน
//   doc id = tokenStore.deviceIdOf(deviceKey) = `app-<sha256 32 ตัว>` (ค่าดิบไม่ถูกเก็บ)
//   ร้าน = access.shopId (doc id ที่ผ่านด่าน) · คน = access.uid (บัญชีที่ล็อกอิน = ค่าเดียวกับ tag id เดิมของ OneSignal) · ❌ ไม่รับจาก body
//   ไม่มี doc        = set รูปเต็ม (PushDevice) · result 'created'
//   มี doc token เดิม = update ร้าน คน รุ่น lastSeenAt · ❌ ไม่ปลด invalid (FCM เพิ่งบอกว่า token นี้ตาย · ปลุกด้วย token เดิมไม่ได้) · 'updated'
//   มี doc token ใหม่ = update + token + invalid:false + tokenUpdatedAt · 'token_updated'
// คำตอบ 200 {ok:true, deviceId, result, byAdmin?} · ไม่คืน token
// ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { DeviceRegisterPushTokenRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminFlag } = require("../_shared/auth");
const { COLLECTION, deviceIdOf } = require("../_shared/push/tokenStore");

const orNull = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

function registerPushToken(deps) {
  return async function handler(req, res) {
    const input = parseOr400(DeviceRegisterPushTokenRequest, req && req.body, res);
    if (!input) return undefined;
    const a = callerAccess(req, input.shopId);
    if (!a.ok) return sendDeny(res, a);
    const access = a.access;
    try {
      const now = await readNow(deps);
      const deviceId = deviceIdOf(input.deviceKey);
      const ref = db.collection(COLLECTION).doc(deviceId);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const base = {
          platform: input.platform, client: "native", staffId: access.uid, shopId: access.shopId,
          appVersion: orNull(input.appVersion), deviceModel: orNull(input.model), lastSeenAt: now, updatedAt: now,
        };
        if (!snap.exists) {
          tx.set(ref, { token: input.pushToken, ...base, invalid: false, createdAt: now });
          return "created";
        }
        const cur = snap.data() || {};
        if (cur.token !== input.pushToken) {
          tx.update(ref, { ...base, token: input.pushToken, invalid: false, tokenUpdatedAt: now });
          return "token_updated";
        }
        tx.update(ref, base);
        return "updated";
      });
      return ok(res, { deviceId, result, ...adminFlag(access) });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { registerPushToken };
