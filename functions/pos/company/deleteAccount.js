// pos/company/deleteAccount — ผู้ใช้ลบบัญชีตัวเอง (ก้อน 9d DEV-0001 · #25 auth C30)
//
// สัญญา: shopchamp-center/api/company.deleteAccount.yaml · คำขอ CompanyDeleteAccountRequest (@shopchamp/schema)
// แทน: main3 src/db/firestore.js:214-244 fbDeleteUser (ล้มทุกครั้งที่ ReferenceError `res` · B1 B2 · ลบแค่ Auth · B8)
// ยังไม่ export จาก index.js และยังไม่ deploy
// route auth 'user' · deps: now · verifyIdToken(token, checkRevoked) · deleteAuthUser(uid) (ไม่ส่ง = admin.auth() ตัวจริง)
//
// ลำดับ:
//   1. ไม่มี req.auth.uid 401 no_auth · รูปคำขอ 400 (confirm:true)
//   2. login ล่าสุดไม่เกิน 5 นาที: ตรวจ token ใน header ซ้ำด้วย verifyIdToken แล้วดู auth_time
//      (แทนการยืนยันตัวในเครื่อง ReAuthenticateScreeen · token เก่า = 401 recent_login_required ให้แอปพาไป login ใหม่)
//   3. transaction (อ่าน profile + บันทึกเดิมก่อนเขียน): deletedUser/{uid} set {uid, authenBy, deleteReason, deletedAt: now, isDeleteSuccess:false, status:'pending', profileDeleted}
//      profileDeleted = มี profile ให้ลบรอบนี้ หรือบันทึกรอบก่อนลบไปแล้ว
//      + ลบ profile/{uid} (ชื่อ เบอร์ อีเมล รายชื่อร้าน · ค้นเบอร์ไม่เจออีก) · ไม่มี profile = ข้าม
//   4. deleteAuthUser(uid) · ไม่มีผู้ใช้แล้ว (auth/user-not-found) = ถือว่าลบแล้ว
//      ล้ม = deletedUser {status:'auth_failed'} แล้ว 502 auth_delete_failed (ลองใหม่ได้ · profile ลบไปแล้วก็ไม่เป็นไร)
//   5. deletedUser {status:'done', isDeleteSuccess:true, finishedAt}
// ❌ ไม่แตะ: ร้าน บิล สมาชิกของร้าน ใบกำกับ (เก็บตามกฎหมาย · #25 ข้อเสนอ) · แถวของคนนี้ใน shop.humanResource (คำถามข้อ 3)
"use strict";

const { db, admin } = require("../../firebase");
const { CompanyDeleteAccountRequest } = require("@shopchamp/schema");
const { ok, fail, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow, depOr } = require("../_shared/deps");

const RECENT_LOGIN_MS = 5 * 60 * 1000;

function bearerOf(req) {
  const h = req && req.headers ? req.headers.authorization || req.headers.Authorization : undefined;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

const realVerify = (t, c) => admin.auth().verifyIdToken(t, c);
const realDeleteUser = (uid) => admin.auth().deleteUser(uid);

function deleteAccount(deps) {
  return async function handler(req, res) {
    try {
      const uid = req && req.auth && typeof req.auth.uid === "string" && req.auth.uid !== "" ? req.auth.uid : "";
      if (!uid) return fail(res, 401, "no_auth");
      const input = parseOr400(CompanyDeleteAccountRequest, req.body, res);
      if (!input) return;
      const now = await readNow(deps);
      const verify = depOr(deps, "verifyIdToken", realVerify);
      const deleteAuthUser = depOr(deps, "deleteAuthUser", realDeleteUser);

      const token = bearerOf(req);
      if (!token) return fail(res, 401, "no_auth");
      let decoded;
      try { decoded = await verify(token, true); } catch (_) { return fail(res, 401, "no_auth"); }
      if (!decoded || decoded.uid !== uid) return fail(res, 401, "no_auth");
      const authMs = typeof decoded.auth_time === "number" && Number.isFinite(decoded.auth_time) ? decoded.auth_time * 1000 : null;
      if (authMs === null || now.getTime() - authMs > RECENT_LOGIN_MS) {
        return sendDeny(res, deny(401, "recent_login_required", "กรุณาเข้าสู่ระบบอีกครั้งก่อนลบบัญชี"));
      }
      const provider = decoded.firebase && typeof decoded.firebase.sign_in_provider === "string" ? decoded.firebase.sign_in_provider : "";

      const recRef = db.collection("deletedUser").doc(uid);
      const profileRef = db.collection("profile").doc(uid);
      await db.runTransaction(async (tx) => {
        const [profileSnap, recSnap] = await Promise.all([tx.get(profileRef), tx.get(recRef)]);
        // ลองซ้ำหลังลบ Auth ล้ม: รอบแรกลบ profile ไปแล้ว ⇒ คงค่า profileDeleted:true ไว้ ไม่ทับเป็น false (ตรวจซ้ำ 9d ข้อสังเกต)
        const prevRec = recSnap.exists && recSnap.data() && typeof recSnap.data() === "object" ? recSnap.data() : {};
        tx.set(recRef, {
          uid,
          authenBy: provider,
          deleteReason: typeof input.reason === "string" ? input.reason : "",
          deletedAt: now,
          isDeleteSuccess: false,
          status: "pending",
          profileDeleted: profileSnap.exists || prevRec.profileDeleted === true,
        });
        if (profileSnap.exists) tx.delete(profileRef);
      });

      try {
        await deleteAuthUser(uid);
      } catch (e) {
        if (!(e && e.code === "auth/user-not-found")) {
          await recRef.update({ status: "auth_failed", isDeleteSuccess: false });
          return sendDeny(res, deny(502, "auth_delete_failed", "ลบบัญชีไม่สำเร็จ กรุณาลองใหม่"));
        }
      }
      await recRef.update({ status: "done", isDeleteSuccess: true, finishedAt: now });
      return ok(res, { deleted: true });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { deleteAccount, RECENT_LOGIN_MS, bearerOf };
