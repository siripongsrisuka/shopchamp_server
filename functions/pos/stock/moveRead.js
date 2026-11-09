// pos/stock/moveRead.js — อ่านจอความเคลื่อนไหวสต๊อก (DEV-0008 · premium)
//
// journalDays: สมุดรายวัน stockJournal ของช่วงวันธุรกิจ (≤ 31 วัน) รวม part ⇒ { days: { YYYYMMDD: { kind: { stockId: qty } } } }
//   Firestore อ่าน: shop/{shopId} · stockJournal where shopId == shopDocId and day in [fromDay, toDay] · index stockJournal(shopId ASC, day ASC)
//   จ่ายตามจำนวน doc ที่มีจริง (ราว 1-18 ต่อวัน) · วันที่ผ่านแล้วไม่มีใครเขียนอีก ⇒ แอปเก็บในเครื่องได้ (วันนี้อ่านใหม่ทุกครั้ง)
// moveList: รายการทีละครั้งของสินค้า 1 ตัว ล่าสุดก่อน แบ่งหน้า (limit ≤ 100 · ไม่ส่ง 50)
//   Firestore อ่าน: shop/{shopId} · stockMove where shopId == shopDocId and stockId == X [and time <= cursor.at] order by time desc limit n+1+slack
//   index stockMove(shopId ASC, stockId ASC, time DESC) · เรียงเวลาเท่ากันด้วย doc id มากก่อน (แบบ report.billList)
// ด่าน: openReport (watcher/ทีมงานอ่านได้) · สิทธิ์พนักงาน '114' คลังสินค้า หรือ '106' รายงาน · ร้านไม่ premium = 403 premium_required (ทีมงานก็ติด)
// shopId ของสมุด/รายการ = shop doc id (ตัวเขียนใช้ access.shopId) ⇒ ค้นด้วย access.shopId ตัวเดียว · doc ร้านอื่นไม่มีทางโผล่ (เงื่อนไข shopId)
// อ่านอย่างเดียว ไม่เขียน · แอปเก่าไม่เห็นอะไรเปลี่ยน
"use strict";

const { StockJournalDaysRequest, StockMoveListRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { db } = require("../../firebase");
const { ok, fail, internalError } = require("../_shared/respond");
const { adminFlag } = require("../_shared/auth");
const { readNow } = require("../_shared/deps");
const { isPremiumActive } = require("../_shared/premium");
const { openReport } = require("../report/_reportShared");

const RIGHTS = ["114", "106"];
const DEFAULT_LIMIT = 50;
const TIE_SLACK = 20;

async function premiumGate(deps, shop, res) {
  const now = await readNow(deps);
  if (isPremiumActive(shop, now)) return true;
  fail(res, 403, "premium_required");
  return false;
}

const round = (v) => Math.round(v * 1e4) / 1e4;

function journalDays(deps) {
  return async function handler(req, res) {
    try {
      const ctx = await openReport(req, res, StockJournalDaysRequest, { rights: RIGHTS });
      if (!ctx) return res;
      const { access, input, shop } = ctx;
      if (!(await premiumGate(deps, shop, res))) return res;
      const snap = await db.collection("stockJournal")
        .where("shopId", "==", access.shopId).where("day", ">=", input.fromDay).where("day", "<=", input.toDay).get();
      const days = {};
      for (const d of snap.docs) {
        const j = d.data() || {};
        if (j.shopId !== access.shopId || typeof j.day !== "string" || typeof j.kind !== "string" || !j.qty || typeof j.qty !== "object") continue;
        const day = (days[j.day] = days[j.day] || {});
        const kind = (day[j.kind] = day[j.kind] || {});
        for (const [id, q] of Object.entries(j.qty)) {
          if (typeof q !== "number" || !Number.isFinite(q)) continue;
          const next = round((kind[id] || 0) + q);
          if (next === 0) delete kind[id];
          else kind[id] = next;
        }
      }
      return ok(res, { ...adminFlag(access), fromDay: input.fromDay, toDay: input.toDay, days });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

const ROW_FIELDS = ["kind", "day", "delta", "before", "after", "byName", "refId", "refNo", "note"];

function moveList(deps) {
  return async function handler(req, res) {
    try {
      const ctx = await openReport(req, res, StockMoveListRequest, { rights: RIGHTS });
      if (!ctx) return res;
      const { access, input, shop } = ctx;
      if (!(await premiumGate(deps, shop, res))) return res;
      const limit = input.limit || DEFAULT_LIMIT;
      let q = db.collection("stockMove").where("shopId", "==", access.shopId).where("stockId", "==", input.stockId);
      let cur = null;
      if (input.cursor) {
        cur = { ms: Date.parse(input.cursor.at), id: input.cursor.id };
        q = q.where("time", "<=", new Date(cur.ms));
      }
      const snap = await q.orderBy("time", "desc").limit(limit + 1 + TIE_SLACK).get();
      let list = snap.docs
        .map((d) => ({ id: d.id, data: d.data() || {} }))
        .filter((e) => e.data.shopId === access.shopId && e.data.stockId === input.stockId)
        .map((e) => ({ ...e, t: logic.toMillis(e.data.time) }))
        .filter((e) => e.t !== null)
        .sort((a, b) => (b.t - a.t) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      if (cur) list = list.filter((e) => e.t < cur.ms || (e.t === cur.ms && e.id < cur.id));
      const page = list.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor = list.length > limit && last ? { at: new Date(last.t).toISOString(), id: last.id } : null;
      const rows = page.map((e) => {
        const r = { id: e.id, time: new Date(e.t).toISOString() };
        for (const f of ROW_FIELDS) r[f] = e.data[f] === undefined ? null : e.data[f];
        if (e.data.byAdmin === true) r.byAdmin = true;
        return r;
      });
      return ok(res, { ...adminFlag(access), stockId: input.stockId, rows, nextCursor });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { journalDays, moveList };
