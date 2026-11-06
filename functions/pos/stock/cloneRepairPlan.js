// pos/stock/cloneRepairPlan — แผนซ่อมร้าน clone แบบฟังก์ชันล้วน (ไม่แตะฐาน) ของ stock.cloneRepair (ก้อน 9a · DEV-0001)
// แยกไฟล์ให้ตัวสร้าง case (lanes/dev/source/chunk9/9a-stock-cases.js) และเทสเรียก buildPlan ได้โดยไม่โหลด functions/firebase
// กติกาการจับคู่ดูหัวไฟล์ cloneRepair.js
"use strict";

const crypto = require("crypto");
const S = require("./_shared");

/** buildPlan(stocks: Map, links: Map) — ฟังก์ชันล้วน (เทสได้โดยไม่มีฐาน) */
function buildPlan(stocks, links) {
  const own = new Set(stocks.keys());
  const bySource = new Map(); // field id → [docId]
  const byBarcode = new Map(); // barcode → [docId] (ไม่นับตัวที่ลบ)
  for (const [docId, d] of stocks) {
    if (S.isNonEmptyString(d.id) && d.id !== docId) bySource.set(d.id, [...(bySource.get(d.id) || []), docId]);
    const b = typeof d.barcode === "number" ? String(d.barcode) : d.barcode;
    if (d.deleted !== true && S.isNonEmptyString(b)) byBarcode.set(b, [...(byBarcode.get(b) || []), docId]);
  }
  const one = (list) => (list && list.length === 1 ? list[0] : null);
  const mapId = (id, barcode) => {
    if (own.has(id)) return id;
    const a = one(bySource.get(id));
    if (a) return a;
    const b = S.isNonEmptyString(barcode) ? one(byBarcode.get(barcode)) : null;
    return b;
  };
  const unresolved = [];
  const linkFixes = [];
  const memberOf = new Map(); // docId → [linkId] หลังจับคู่
  for (const [linkId, l] of links) {
    const rows = Array.isArray(l.stockLink) ? l.stockLink : [];
    let changed = false;
    let broken = false;
    const next = rows.map((m) => {
      if (!S.isObj(m)) return m;
      const to = mapId(m.id, typeof m.barcode === "number" ? String(m.barcode) : m.barcode);
      if (!to) { broken = true; unresolved.push({ kind: "link_member", linkId, memberId: m.id }); return m; }
      if (to !== m.id) changed = true;
      memberOf.set(to, [...(memberOf.get(to) || []), linkId]);
      return { ...m, id: to };
    });
    if (changed && !broken) linkFixes.push({ id: linkId, stockLink: next });
  }
  const stockFixes = [];
  for (const [docId, d] of stocks) {
    if (d.deleted === true) continue;
    const detail = Array.isArray(d.linkDetail) ? d.linkDetail : [];
    const foreignDetail = detail.some((r) => S.isObj(r) && !own.has(r.id));
    const linkForeign = S.isNonEmptyString(d.linkId) && !links.has(d.linkId);
    const nextForeign = S.isNonEmptyString(d.linkNext) && !own.has(d.linkNext);
    if (!foreignDetail && !linkForeign && !nextForeign) continue;
    let bad = false;
    const linkDetail = detail.map((r) => {
      if (!S.isObj(r)) return r;
      const to = mapId(r.id, null);
      if (!to) { bad = true; return r; }
      return { ...r, id: to };
    });
    let linkId = d.linkId;
    if (linkForeign) {
      const cands = [...new Set(memberOf.get(docId) || [])];
      if (cands.length === 1) linkId = cands[0];
      else bad = true;
    }
    let linkNext = d.linkNext;
    if (nextForeign) {
      linkNext = mapId(d.linkNext, d.linkNext); // /cloneShop เก็บ barcode ไว้ที่นี่
      if (!linkNext) bad = true;
    }
    if (bad) { unresolved.push({ kind: "stock", id: docId }); continue; }
    stockFixes.push({ id: docId, linkDetail, linkId, linkNext });
  }
  const counts = { stocks: stocks.size, links: links.size, stockFixes: stockFixes.length, linkFixes: linkFixes.length, unresolved: unresolved.length };
  const planHash = crypto.createHash("sha256").update(JSON.stringify({ stockFixes, linkFixes })).digest("hex").slice(0, 16);
  return { planHash, counts, stockFixes, linkFixes, unresolved };
}

module.exports = { buildPlan };
