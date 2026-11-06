// pos/company/scanLoginApprove — แอปสแกน QR เข้าเว็บเจ้าของร้านรุ่นเดิม (ก้อน 9d DEV-0001)
//
// สัญญา: shopchamp-center/api/company.scanLoginApprove.yaml · คำขอ CompanyScanLoginApproveRequest (@shopchamp/schema)
// แทน: main3 src/screens/LinkingWebsiteScreen.js:44-55 `db.collection('loginByScan').doc(docId).update({uid})` (ไม่ await · ขึ้นสำเร็จเสมอ B1)
// ยังไม่ export จาก index.js และยังไม่ deploy
//
// ขอบเขต (ใบนี้ทำเท่าที่ต้องย้ายการเขียนออกจากแอป · decision DEV-0004 2026-11-05):
//   ✅ ปิดได้ที่นี่: B1 (doc ไม่มี = 404 แอปบอกผู้ใช้) · B5 ส่วน "ใช้ซ้ำ/ไม่หมดอายุ" (สแกนแล้วใช้ซ้ำไม่ได้ · QR เก่ากว่า 10 นาที = 410)
//     uid มาจาก token เท่านั้น (เดิม profile.id ใน redux)
//   ❌ ไม่ปิดที่นี่ (งาน DEV-0004): `/users/scan` ยังออก token ให้ uid ใดก็ได้ (B15) · เว็บเดิมยังพึ่ง doc นี้ · ทางใหม่ start/approve/claim
//     แบบบ้านพี่น้อง (session + secret ไม่อยู่ใน QR) ต้องมีเว็บใหม่ (DEV-0002) และ route สาธารณะ 2 ตัว ⇒ ไม่ทำในใบนี้
// route auth 'user' (ไม่ผูกร้าน · เว็บตัดสินร้านเองหลัง login จาก humanResource · own:screens/HomeScreen.js:113)
//
// ลำดับ: ไม่มี req.auth.uid 401 no_auth → รูปคำขอ 400 → transaction:
//   ไม่มี doc 404 scan_not_found · uid ของ doc เป็นคนนี้แล้ว 200 duplicate · เป็นคนอื่น 409 already_used
//   อายุ QR (410 scan_expired) ตัดสินจาก 2 ทาง ต้องผ่านทั้งคู่:
//     ① snap.createTime = เวลาที่ server ของ Firestore ตั้งตอน doc เกิด (เว็บแก้ไม่ได้) เก่ากว่า 10 นาที = หมดอายุ ← ตัวกันภัย B5 จริง
//        (field timestamp เว็บเขียนเอง · rules เปิด ⇒ คนร้ายสร้าง QR เองใส่ปี 2099 ได้ · ตรวจซ้ำ 9d ข้อผิด 1)
//        Admin SDK ใส่ createTime ทุก doc ที่มีอยู่ · ฐานปลอมของ harness ไม่มี ⇒ ข้าม (ทางที่ ② ยังคุม) · เทส handler คุมทางนี้
//     ② field timestamp: ไม่มี/อ่านไม่ได้ = หมดอายุ (fail-closed · ทาง /scan ของเว็บเดิมไม่เขียน · คำถามข้อ 4)
//        เก่ากว่า 10 นาที หรือ ล้ำหน้าเวลา server เกิน 10 นาที = หมดอายุ (นาฬิกาเว็บเดินเร็วเล็กน้อยยังผ่าน)
//   เขียน update {uid, approvedAt: now, approvedVia:'pos'} (เพิ่มอย่างเดียว · เว็บเดิมดูแค่ uid ใน snapshot modified)
"use strict";

const { db } = require("../../firebase");
const { CompanyScanLoginApproveRequest } = require("@shopchamp/schema");
const { ok, fail, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");

const SCAN_TTL_MS = 10 * 60 * 1000;

class Refusal extends Error {
  constructor(d) { super(d.error); this.deny = d; }
}
const refuse = (d) => { throw new Refusal(d); };

function msOf(t) {
  if (t instanceof Date) return Number.isFinite(t.getTime()) ? t.getTime() : null;
  if (t && typeof t === "object" && typeof t.toMillis === "function") {
    const ms = t.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function scanLoginApprove(deps) {
  return async function handler(req, res) {
    try {
      const uid = req && req.auth && typeof req.auth.uid === "string" && req.auth.uid !== "" ? req.auth.uid : "";
      if (!uid) return fail(res, 401, "no_auth");
      const input = parseOr400(CompanyScanLoginApproveRequest, req.body, res);
      if (!input) return;
      const now = await readNow(deps);
      const ref = db.collection("loginByScan").doc(input.docId);

      const out = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) refuse(deny(404, "scan_not_found", "ไม่พบ QR นี้ ลองขอ QR ใหม่บนเว็บ"));
        const d = snap.data() || {};
        if (typeof d.uid === "string" && d.uid !== "") {
          if (d.uid === uid) return { duplicate: true };
          refuse(deny(409, "already_used", "QR นี้ถูกใช้ไปแล้ว ลองขอ QR ใหม่บนเว็บ"));
        }
        const expired = () => refuse(deny(410, "scan_expired", "QR หมดอายุแล้ว ลองขอ QR ใหม่บนเว็บ"));
        const createdMs = msOf(snap.createTime);
        if (createdMs !== null && now.getTime() - createdMs > SCAN_TTL_MS) expired();
        const ms = msOf(d.timestamp);
        if (ms === null || now.getTime() - ms > SCAN_TTL_MS || ms - now.getTime() > SCAN_TTL_MS) expired();
        tx.update(ref, { uid, approvedAt: now, approvedVia: "pos" });
        return { duplicate: false };
      });
      return ok(res, { docId: input.docId, duplicate: out.duplicate });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { scanLoginApprove, SCAN_TTL_MS };
