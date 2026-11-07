// pos/report/memberBills — บิลของสมาชิก 1 คนในร้าน ล่าสุดก่อน แบ่งหน้า (DEV-0002 · เว็บเจ้าของร้าน census 256)
//
// สัญญา: shopchamp-center/api/report.memberBills.yaml · route POST /pos_heavy/report/member-bills
// รูป: factory (deps) => handler(req, res)
// แทน: own:redux/memberSlice.js fetchMemberBill · เดิมเบราว์เซอร์ค้น bill where member.id == x order by dateTime desc limit 100
//   ไม่กรองร้าน (สมาชิกร้านอื่นที่ id ชนกันโผล่ได้) · ตัดใบยกเลิกหลังได้ 100 ใบ (หน้าแรกได้น้อยกว่า 100)
//   ใหม่: ด่านตัวตนและร้าน · บิลร้านอื่นไม่ปน (mergeSnaps + belongsToShop) · ใบยกเลิกไม่นับ · แถวเดียวกับ report.billList detail
// ไม่มีด่านแพ็กเกจ 62 วัน (เว็บเดิมไม่มีช่วงวันในจอนี้)
// สิทธิ์: พนักงานต้องมี '117' หรือ '106'
// แบ่งหน้า: เรียง dateTime ใหม่ก่อน เวลาเท่ากัน doc id มากก่อน · cursor = {at, id} ของแถวสุดท้าย · ค้นเผื่อ SLACK แถว (ใบยกเลิก · เวลาชน)
//   ❓ ใบยกเลิกหรือบิลร้านอื่นที่ member.id เดียวกันเกิน SLACK ในหน้าเดียว = หน้านั้นได้น้อยกว่า pageSize แต่ nextCursor ยังพาไปต่อได้
// Firestore อ่าน: shop/{shopId} · bill where member.id == memberId [and dateTime <= cursor.at] order by dateTime desc limit
//   (index bill(member.id ASC, dateTime DESC) มีแล้วใน firestore.indexes.json) · เขียน: ไม่มี
"use strict";

const { ReportMemberBillsRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { db } = require("../../firebase");
const { ok, internalError } = require("../_shared/respond");
const { adminFlag } = require("../_shared/auth");
const { RIGHT, openReport, mergeSnaps } = require("./_reportShared");

const DEFAULT_PAGE = 100;
const SLACK = 50;

const timeOf = (data) => {
  const m = logic.toMillis(data && data.dateTime);
  return m === null ? -Infinity : m;
};

function memberBills() {
  return async function handler(req, res) {
    try {
      const ctx = await openReport(req, res, ReportMemberBillsRequest, { rights: [RIGHT.BILL_HISTORY, RIGHT.REPORT] });
      if (!ctx) return res;
      const { access, input, shop, shopRef } = ctx;
      const pageSize = input.pageSize || DEFAULT_PAGE;
      const fetchN = pageSize + 1 + SLACK;
      const cur = input.cursor ? { ms: Date.parse(input.cursor.at), id: input.cursor.id } : null;
      let q = db.collection("bill").where("member.id", "==", input.memberId);
      if (cur) q = q.where("dateTime", "<=", new Date(cur.ms));
      const snap = await q.orderBy("dateTime", "desc").limit(fetchN).get();
      const raw = snap && Array.isArray(snap.docs) ? snap.docs.length : 0;
      let list = mergeSnaps([snap], shopRef)
        .map((e) => ({ e, t: timeOf(e.data) }))
        .sort((a, b) => (b.t - a.t) || (a.e.id < b.e.id ? 1 : a.e.id > b.e.id ? -1 : 0));
      if (cur) list = list.filter(({ e, t }) => t < cur.ms || (t === cur.ms && e.id < cur.id));
      const scanned = list; // ก่อนตัดใบยกเลิก (ใช้ชี้หน้าถัดไป)
      const live = list.filter(({ e }) => !logic.isVoidedBill(e.data));
      const page = live.slice(0, pageSize);
      // มีของเหลือ = ได้ใบมากกว่าหน้า หรือฐานคืนเต็มเพดาน (ยังมีใบที่ไม่ได้อ่าน)
      const more = live.length > pageSize || raw >= fetchN;
      const lastRow = page.length === pageSize ? page[page.length - 1] : scanned[scanned.length - 1];
      const nextCursor = more && lastRow && Number.isFinite(lastRow.t) ? { at: new Date(lastRow.t).toISOString(), id: lastRow.e.id } : null;
      return ok(res, {
        ...adminFlag(access),
        memberId: input.memberId,
        rows: page.map(({ e }) => ({ ...logic.reportBillRow(e.id, e.data, shop.cutOff), detail: logic.billDetailOf(e.data), bill: logic.plainDoc(e.data) })),
        nextCursor,
      });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { memberBills };
