// pos/office/whoami — shopchampoffice ถามว่าคนที่ login อยู่เข้าได้ไหม เป็นระดับไหน (DEV-0003)
//
// สัญญา: shopchamp-center/api/office.whoami.yaml · คำขอ OfficeWhoamiRequest
// route auth 'user' · ตัดสินจาก watcher/roster ที่ server อ่านเอง (client ไม่อ่าน doc ทะเบียน)
// คืน 200 เสมอเมื่อ login แล้ว (คนนอกก็ 200 staffRole 'none') ⇒ จอแยก "ไม่มีสิทธิ์" ออกจาก "server ล่ม/ยังไม่ deploy" ได้
//   root ได้รายการกุญแจของตัวเอง (passkeys · passkeyMax) ไว้ให้จอรู้ว่าต้องลงทะเบียนเครื่องก่อนไหม
"use strict";

const { OfficeWhoamiRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const WR = require("../_shared/watcherRoster");
const S = require("./_officeStore");
const C = require("./_officeCore");

function whoami() {
  return async function handler(req, res) {
    try {
      const caller = S.callerOf(req);
      if (!parseOr400(OfficeWhoamiRequest, req.body, res)) return;
      const { role } = await S.readRole(caller.uid);
      const body = { uid: caller.uid, email: caller.email, staffRole: role, canEdit: role === WR.ROLE.ROOT };
      if (role === WR.ROLE.ROOT) {
        body.passkeys = (await S.listCredentials(caller.uid)).map(S.credShape);
        body.passkeyMax = C.MAX_PASSKEYS_PER_USER;
      }
      return ok(res, body);
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { whoami };
