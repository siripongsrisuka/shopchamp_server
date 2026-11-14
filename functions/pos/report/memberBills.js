// pos/report/memberBills — บิลของสมาชิก 1 คนในร้าน ล่าสุดก่อน แบ่งหน้า (DEV-0002 · เว็บเจ้าของร้าน census 256)
//
// สัญญา: shopchamp-center/api/report.memberBills.yaml · route POST /pos_heavy/report/member-bills
// รูป: factory (deps) => handler(req, res)
// แทน: own:redux/memberSlice.js fetchMemberBill · เดิมเบราว์เซอร์ค้น bill where member.id == x order by dateTime desc limit 100
//   ไม่กรองร้าน (สมาชิกร้านอื่นที่ id ชนกันโผล่ได้) · ตัดใบยกเลิกหลังได้ 100 ใบ (หน้าแรกได้น้อยกว่า 100)
//   ใหม่: ด่านตัวตนและร้าน · บิลร้านอื่นไม่ปน (mergeSnaps + belongsToShop) · ใบยกเลิกไม่นับ · แถวเดียวกับ report.billList detail
// ไม่มีด่านแพ็กเกจ 62 วัน (เว็บเดิมไม่มีช่วงวันในจอนี้)
// สิทธิ์: พนักงานต้องมี '117' หรือ '106' (เว็บเจ้าของร้าน · ชุดเดิม ห้ามแคบลง) หรือ '107' / '101' (จอประวัติซื้อของแอป)
//   DEV-0010 (Pack คิวข้อ 9 · 2026-11-14 · เท่าที่แอปเปิดที่จอ): แอปเข้าจอ MemberBillScreen / MemberDashboardScreen ได้จาก MemberScreen
//     ซึ่งเปิดได้ 2 ทาง: ไทล์ '107' สมาชิก (`shopchamp_app/src/screens/HomeScreen.js:89`) หรือ '101' ตั้งค่า → ขั้นสูง → ระบบสมาชิก
//     (`HomeScreen.js:81` → `ShopSettingScreen.js:24` → `AdvanceScreen.js:26` → `MainMemberScreen.js:20`) · จอทั้ง 3 ไม่ตรวจสิทธิ์เพิ่ม
//     ⇒ เท่ากับ member.paidHistory (pos/member/read.js memberScreenRight) · '107' ใส่ตรงไว้ ไม่พึ่ง legacy reportRights ที่จะถูกขันทีหลัง
// แบ่งหน้า: เรียง dateTime ใหม่ก่อน เวลาเท่ากัน doc id มากก่อน · cursor = {at, id} ของแถวสุดท้ายที่อ่าน (รูปเดิม)
//   DEV-0010 (Pack เคาะคิวข้อ 4 · 2026-11-14): เลิก SLACK · ค้น orderBy dateTime desc, __name__ desc + startAfter(at, id) limit pageSize+1
//     อ่าน pageSize ใบถัดจาก cursor (+1 ใบไว้รู้ว่ามีหน้าต่อ) · ใบยกเลิก/บิลร้านอื่นในนั้นตัดทิ้ง ⇒ หน้านั้นได้น้อยกว่า pageSize ได้
//     (เท่าของเดิมของเว็บ: limit 100 แล้วตัดใบยกเลิกในเครื่อง) · nextCursor ชี้ใบสุดท้ายที่อ่าน (ไม่ใช่ใบสุดท้ายที่คืน) ⇒ ไม่อ่านซ้ำ ไม่ข้าม
//     ยังคง dateTime <= at ในคำค้น (ซ้ำกับ startAfter ไม่เปลี่ยนผล) + ตัดแถวไม่อยู่หลัง cursor ในหน่วยความจำ (ฐานปลอมไม่ดู startAfter)
// Firestore อ่าน: shop/{shopId} · bill where member.id == memberId [and dateTime <= cursor.at] order by dateTime desc, __name__ desc [startAfter] limit pageSize+1
//   (index bill(member.id ASC, dateTime DESC, __name__ DESC) มีแล้วใน firestore.indexes.json) · เขียน: ไม่มี
"use strict";

const { ReportMemberBillsRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { db } = require("../../firebase");
const { ok, internalError } = require("../_shared/respond");
const { adminFlag } = require("../_shared/auth");
const { RIGHT, openReport, mergeSnaps } = require("./_reportShared");

const DEFAULT_PAGE = 100;
const MEMBER_SCREEN_RIGHTS = Object.freeze(["107", "101"]); // ไทล์สมาชิก · ตั้งค่า (ทางเข้าจอสมาชิกของแอป)

const timeOf = (data) => {
  const m = logic.toMillis(data && data.dateTime);
  return m === null ? -Infinity : m;
};

function memberBills() {
  return async function handler(req, res) {
    try {
      const ctx = await openReport(req, res, ReportMemberBillsRequest, { rights: [RIGHT.BILL_HISTORY, RIGHT.REPORT, ...MEMBER_SCREEN_RIGHTS] });
      if (!ctx) return res;
      const { access, input, shop, shopRef } = ctx;
      const pageSize = input.pageSize || DEFAULT_PAGE;
      const cur = input.cursor ? { ms: Date.parse(input.cursor.at), id: input.cursor.id } : null;
      let q = db.collection("bill").where("member.id", "==", input.memberId);
      if (cur) q = q.where("dateTime", "<=", new Date(cur.ms));
      q = q.orderBy("dateTime", "desc").orderBy("__name__", "desc");
      if (cur) q = q.startAfter(new Date(cur.ms), cur.id);
      const snap = await q.limit(pageSize + 1).get();
      // เรียงและตัดตาม cursor ก่อนกรองร้าน/ใบยกเลิก ⇒ cursor ชี้ใบสุดท้ายที่อ่านจริง
      let scanned = (snap && Array.isArray(snap.docs) ? snap.docs : [])
        .map((d) => ({ id: d.id, data: d.data(), t: timeOf(d.data()) }))
        .sort((a, b) => (b.t - a.t) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      if (cur) scanned = scanned.filter(({ id, t }) => t < cur.ms || (t === cur.ms && id < cur.id));
      const more = scanned.length > pageSize;
      const win = scanned.slice(0, pageSize);
      const page = mergeSnaps([{ docs: win.map((x) => ({ id: x.id, data: () => x.data })) }], shopRef)
        .filter((e) => !logic.isVoidedBill(e.data));
      const last = win[win.length - 1];
      const nextCursor = more && last && Number.isFinite(last.t) ? { at: new Date(last.t).toISOString(), id: last.id } : null;
      return ok(res, {
        ...adminFlag(access),
        memberId: input.memberId,
        rows: page.map((e) => ({ ...logic.reportBillRow(e.id, e.data, shop.cutOff), detail: logic.billDetailOf(e.data), bill: logic.plainDoc(e.data) })),
        nextCursor,
      });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { memberBills };
