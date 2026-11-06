// pos/franchise/billList.js — บิลของแฟรนไชส์ในช่วงวันธุรกิจ (ก้อน 9f · DEV-0002) · อ่านอย่างเดียว · function pos_heavy
//
// สัญญา: shopchamp-center/api/franchise.billList.yaml
// แทน (census chunk6-log.md): 288 `fr:redux/billSlice.js:16-56` (bill where franchiseId == x and billDate in [วันปฏิทิน] ทีละ 10 วัน)
//   ผู้ใช้: Dashboard (100) · ยอดตามร้าน (103) · ยอดตามสินค้า (104) ⇒ ต้องมีสิทธิ์ตัวใดตัวหนึ่ง
// ที่เปลี่ยน:
//   WR-01 ฝั่งแฟรนไชส์: วันของบิล = วันธุรกิจตาม cutOff ของสาขาที่ขาย (logic.reportRange ตัวเดียวกับรายงานร้าน 9e) ไม่ใช่วันปฏิทิน
//     ⇒ ค้น billDate (วันปฏิทิน) ตั้งแต่ fromDay ถึง toDay+1 แล้วกรองด้วยเวลาขาย start < เวลา <= end ของสาขานั้น
//     สาขาที่ออกจากแฟรนไชส์แล้ว (บิลยังถือ franchiseId เดิม · WR-72 คงเดิม) อ่าน cutOff จาก doc ร้าน · หาร้านไม่เจอ = ตัดเที่ยงคืน
//   WR-04: ใบยกเลิก (logic.isVoidedBill) ไม่อยู่ในรายการ · นับแยกใน voided {count, net}
//   shopId (ไม่ส่งได้) = สาขาเดียว · ไม่ใช่สาขาของแฟรนไชส์ตอนนี้ = 409 shop_not_in_franchise
// คำตอบ: แถวย่อเท่าที่ 3 จอใช้ (shopId billDate dateTime net product[id name barcode qty net]) · ไม่คืนสมาชิก/ช่องจ่าย
"use strict";

const { db } = require("../../firebase");
const { deny } = require("../_shared/respond");
const logic = require("@shopchamp/logic");
const F = require("./_franchise");

const plain = (ref) => ref.get();
const IN_MAX = 30; // Firestore `in` รับได้ไม่เกิน 30 ค่า
const ROW_MAX = 20000;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** วันปฏิทิน 'YYYYMMDD' ตั้งแต่ a ถึง b (รวม) */
function calendarKeys(a, b) {
  const toDate = (k) => new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(4, 6)) - 1, Number(k.slice(6, 8))));
  const out = [];
  for (let t = toDate(a).getTime(); t <= toDate(b).getTime(); t += 86400000) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`);
  }
  return out;
}

const billList = F.makeHandler("FranchiseBillListRequest", async ({ uid, input }) => {
  await F.readGate(plain, input.franchiseId, uid, { rights: [F.RIGHT.DASHBOARD, F.RIGHT.BY_SHOP, F.RIGHT.BY_ITEM] });
  const probe = logic.reportRange({ fromDay: input.fromDay, toDay: input.toDay });
  if (!probe.ok) F.refuse(deny(400, "range_invalid", "ช่วงวันไม่ถูกต้อง (ไม่เกิน 31 วัน)", { reason: probe.reason }));

  // สาขาตอนนี้ · ค่า shopId ที่บิลถือได้ = doc id หรือ field shopId ของร้าน (ร้านรุ่นเก่า S5)
  const shopSnap = await db.collection("shop").where("franchiseId", "==", input.franchiseId).get();
  const branchOf = new Map(); // ค่าในบิล → {id, cutOff}
  for (const d of shopSnap.docs) {
    const s = d.data() || {};
    const b = { id: d.id, cutOff: s.cutOff };
    branchOf.set(d.id, b);
    if (typeof s.shopId === "string" && s.shopId && !branchOf.has(s.shopId)) branchOf.set(s.shopId, b);
  }
  if (input.shopId !== undefined && !shopSnap.docs.some((d) => d.id === input.shopId)) {
    F.refuse(deny(409, "shop_not_in_franchise", "ร้านนี้ไม่ใช่สาขาของแฟรนไชส์นี้"));
  }

  // วันปฏิทิน fromDay..toDay+1 (cutOff หลังเที่ยงคืนทำให้วันธุรกิจกินเช้าวันถัดไป)
  const keys = calendarKeys(input.fromDay, nextKey(input.toDay));
  const snaps = [];
  for (let i = 0; i < keys.length; i += IN_MAX) {
    snaps.push(db.collection("bill").where("franchiseId", "==", input.franchiseId).where("billDate", "in", keys.slice(i, i + IN_MAX)).get());
  }
  const docs = [];
  const seen = new Set();
  for (const s of await Promise.all(snaps)) for (const d of s.docs) if (!seen.has(d.id)) { seen.add(d.id); docs.push(d); }

  // ร้านที่ไม่อยู่ในสาขาตอนนี้: อ่าน doc ร้านเพื่อเอา cutOff (ทีละ id ที่บิลถือ)
  const unknown = [...new Set(docs.map((d) => F.str((d.data() || {}).shopId)).filter((k) => k && !branchOf.has(k)))];
  const extra = await Promise.all(unknown.map((k) => db.collection("shop").doc(k).get()));
  const cutOffOf = new Map(unknown.map((k, i) => [k, extra[i].exists ? (extra[i].data() || {}).cutOff : undefined]));

  const ranges = new Map();
  const rangeOf = (cutOff) => {
    const key = String(cutOff && typeof cutOff.toMillis === "function" ? cutOff.toMillis() : cutOff instanceof Date ? cutOff.getTime() : cutOff);
    if (!ranges.has(key)) ranges.set(key, logic.reportRange({ fromDay: input.fromDay, toDay: input.toDay, cutOff }));
    return ranges.get(key);
  };

  const rows = [];
  const voided = { count: 0, net: 0 };
  for (const d of docs) {
    const b = d.data() || {};
    const raw = F.str(b.shopId);
    const branch = branchOf.get(raw);
    if (input.shopId !== undefined && (!branch || branch.id !== input.shopId)) continue;
    const r = rangeOf(branch ? branch.cutOff : cutOffOf.get(raw));
    const ms = logic.saleMsOf(b);
    if (!r.ok || ms === null || !(ms > r.start.getTime() && ms <= r.end.getTime())) continue;
    const net = num(b.moneyMustPaid);
    if (logic.isVoidedBill(b)) { voided.count++; voided.net += net; continue; }
    rows.push({
      id: d.id,
      shopId: branch ? branch.id : raw,
      billDate: F.str(b.billDate),
      dateTime: new Date(ms).toISOString(),
      net,
      product: F.arr(b.product).filter(F.isObj).map((p) => ({
        id: F.str(p.id), name: F.str(p.name), barcode: p.barcode === undefined || p.barcode === null ? "" : String(p.barcode), qty: num(p.qty), net: num(p.net),
      })),
    });
    if (rows.length > ROW_MAX) F.refuse(deny(409, "range_too_large", "บิลมากเกินไป เลือกช่วงวันให้สั้นลง", { max: ROW_MAX }));
  }
  rows.sort((a, b) => (a.dateTime < b.dateTime ? 1 : a.dateTime > b.dateTime ? -1 : 0));
  voided.net = Math.round(voided.net * 10000) / 10000;
  return { fromDay: input.fromDay, toDay: input.toDay, bills: rows, count: rows.length, voided, ...(input.shopId ? { shopId: input.shopId } : {}) };
});

function nextKey(k) {
  const d = new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(4, 6)) - 1, Number(k.slice(6, 8))) + 86400000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

module.exports = { billList, calendarKeys };
