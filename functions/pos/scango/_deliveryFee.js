// pos/scango/_deliveryFee.js — สูตรค่าส่งแบบช่วงของร้าน Shopchamp บน ScanGo (pure · ไม่แตะฐาน) · รอบ 5 Pack เคาะ 2026-11-12
//
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/scango/deliveryFee.js` (คัดมาทั้งสูตร · ตัวเลข/ข้อความ/ด่านเดียวกัน)
//   สูตร: ค่าเริ่มต้น `baseFee` สำหรับ `baseKm` แรก + ช่วงถัดไปติดกัน `bands[]` คิด `perKm` × กม.ในช่วง · สูงสุด 5 ช่วง
//   ไกลสุด = bands[last].toKm (ไม่มีช่วง = baseKm) · เกินไกลสุด = outOfRange (ScanGo ซ่อนร้าน / สั่งไม่ได้)
//   ปัดเศษ: ระยะปัดขึ้น 0.1 กม. · ค่าส่งปัดขึ้นบาทเต็ม (คนรับเงินคือไรเดอร์) · อยู่ในฟังก์ชันเดียว
// ที่เก็บของบ้านนี้: `shop.scango.deliveryFeeModel` (ต้นแบบเก็บใต้ `scango.ordering` · บ้านนี้ค่าตั้งอยู่ระดับ `shop.scango` ตรง)
// ร้านที่ตั้งไว้แบบเดิม (เหมา `deliveryFee` + `maxKm` จาก scango.settingsSave · แอป 5.00 รุ่นแรก) = อ่านเป็นสูตร 1 ช่วง
//   {baseKm: maxKm, baseFee: deliveryFee, bands: []} (ตัวเลขเท่าเดิมทุกระยะ · ต่างแค่ปัดค่าส่งขึ้นบาทเต็มแบบต้นแบบ) · ❌ ไม่ migrate ข้อมูล
//   มีแต่ deliveryFee ไม่มี maxKm = เหมาใน LEGACY_FLAT_MAX_KM (ท่าเดียวกับต้นแบบ) · ไม่เคยตั้งอะไร = preset กรมขนส่ง (ท่าเดียวกับต้นแบบ)
// ส่งฟรีครบยอดแบบเดิม (`shop.scango.freeDeliveryMin`) = ยังคิดใน quote ให้ร้านที่ตั้งไว้ (ขั้นเดียว ลดเต็มค่าส่ง · ร้านออกแทน)
//   ❌ ไม่ส่งในเมนูแล้ว (รอบ 5: โปร/ส่วนลดค่าส่งเป็นของ ScanGo) · ตั้งใหม่ทางเว็บไม่ได้ (relay ordering ไม่รับช่องนี้)
//   ⚠️ ส่วนลดจากโปรของ ScanGo ใน orderCreate = รอ Pack เคาะ (ไฟล์นี้ไม่แตะ)
"use strict";

const MAX_BANDS = 5;
const DISTANCE_KIND = "road";
/** ค่าตั้งต้นร้านใหม่ = เพดานกรมการขนส่งทางบก (ค่าเดียวกับต้นแบบ): 2 กม.แรก ฿25 · 2–5 กม.ละ ฿5 · 5–15 กม.ละ ฿10 */
const DEFAULT_MODEL = Object.freeze({
  distance: DISTANCE_KIND,
  baseKm: 2,
  baseFee: 25,
  bands: Object.freeze([Object.freeze({ toKm: 5, perKm: 5 }), Object.freeze({ toKm: 15, perKm: 10 })]),
});
const LEGACY_FLAT_MAX_KM = 15;
const EPS = 1e-9;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
function num(v) {
  if (isNum(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const noNegZero = (n) => (n === 0 ? 0 : n);
const roundKmUp = (km) => noNegZero(Math.ceil(km * 10 - EPS) / 10);
const roundBahtUp = (b) => noNegZero(Math.ceil(b - EPS));

/** ตรวจสูตร → {ok:true, model} (normalized) | {ok:false, errors:[{field,message}]} — กฎ/ข้อความเดียวกับต้นแบบ */
function validateDeliveryFeeModel(model) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });
  if (!isObj(model)) return { ok: false, errors: [{ field: "deliveryFeeModel", message: "ต้องเป็น object { baseKm, baseFee, bands }" }] };
  const distance = model.distance === undefined || model.distance === null ? DISTANCE_KIND : model.distance;
  if (distance !== DISTANCE_KIND) err("distance", `distance ต้องเป็น '${DISTANCE_KIND}' (ระยะถนนจริง)`);
  const baseKm = num(model.baseKm);
  if (baseKm === null) err("baseKm", "กม.แรกต้องเป็นตัวเลข");
  else if (baseKm <= 0) err("baseKm", "กม.แรกต้องมากกว่า 0 (ใส่ 1 ถ้าอยากเริ่มคิดต่อกม.เร็ว)");
  const baseFee = num(model.baseFee);
  if (baseFee === null) err("baseFee", "ค่าเริ่มต้นต้องเป็นตัวเลข");
  else if (baseFee < 0) err("baseFee", "ค่าเริ่มต้นต้องไม่ติดลบ");
  const bandsIn = model.bands === undefined || model.bands === null ? [] : model.bands;
  const bands = [];
  if (!Array.isArray(bandsIn)) err("bands", "bands ต้องเป็น array");
  else {
    if (bandsIn.length > MAX_BANDS) err("bands", `ช่วงได้สูงสุด ${MAX_BANDS} ช่วง (ส่งมา ${bandsIn.length})`);
    let floor = baseKm;
    bandsIn.slice(0, MAX_BANDS).forEach((b, i) => {
      const n = i + 1;
      if (!b || typeof b !== "object") { err(`bands[${i}]`, `ช่วง ${n}: ต้องเป็น { toKm, perKm }`); return; }
      const toKm = num(b.toKm);
      const perKm = num(b.perKm);
      if (toKm === null) err(`bands[${i}].toKm`, `ช่วง ${n}: "ถึง" ต้องเป็นตัวเลข`);
      else if (floor !== null && toKm <= floor + EPS) err(`bands[${i}].toKm`, `ช่วง ${n}: "ถึง" ต้องมากกว่า "จาก" (${round1(floor)} กม.)`);
      if (perKm === null) err(`bands[${i}].perKm`, `ช่วง ${n}: กม.ละต้องเป็นตัวเลข`);
      else if (perKm < 0) err(`bands[${i}].perKm`, `ช่วง ${n}: กม.ละต้องไม่ติดลบ · ใส่ 0 ถ้าช่วงนี้ไม่คิดเพิ่ม`);
      if (toKm !== null) floor = toKm;
      bands.push({ toKm, perKm });
    });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    model: { distance: DISTANCE_KIND, baseKm: round1(baseKm), baseFee: round2(baseFee), bands: bands.map((b) => ({ toKm: round1(b.toKm), perKm: round2(b.perKm) })) },
  };
}

/** ไกลสุดที่ร้านส่ง (กม.) = ขอบช่วงสุดท้าย · ไม่มีช่วง = baseKm */
function maxKmOf(model) {
  const m = model || {};
  const bands = Array.isArray(m.bands) ? m.bands : [];
  return bands.length ? Number(bands[bands.length - 1].toKm) : Number(m.baseKm);
}

const presetModel = () => ({ distance: DISTANCE_KIND, baseKm: DEFAULT_MODEL.baseKm, baseFee: DEFAULT_MODEL.baseFee, bands: DEFAULT_MODEL.bands.map((b) => ({ ...b })) });

/**
 * resolveDeliveryConfig(scango) — สูตรที่ใช้จริงจาก `shop.scango` (อ่านทั้ง 2 แบบ)
 *   ลำดับ: deliveryFeeModel (ผ่านด่าน) → เหมาเดิม (maxKm > 0 หรือ deliveryFee > 0) → preset
 * @returns {{model, source:'model'|'legacy'|'preset', maxKm:number, freeDeliveryMin:number}}
 */
function resolveDeliveryConfig(scango) {
  const s = isObj(scango) ? scango : {};
  const fdm = num(s.freeDeliveryMin);
  const freeDeliveryMin = fdm !== null && fdm > 0 ? round2(fdm) : 0;
  if (s.deliveryFeeModel !== undefined && s.deliveryFeeModel !== null) {
    const v = validateDeliveryFeeModel(s.deliveryFeeModel);
    if (v.ok) return { model: v.model, source: "model", maxKm: maxKmOf(v.model), freeDeliveryMin };
  }
  const fee = num(s.deliveryFee);
  const km = num(s.maxKm);
  const hasKm = km !== null && km > 0;
  if (hasKm || (fee !== null && fee > 0)) {
    const model = { distance: DISTANCE_KIND, baseKm: round1(hasKm ? km : LEGACY_FLAT_MAX_KM), baseFee: round2(fee !== null && fee > 0 ? fee : 0), bands: [] };
    return { model, source: "legacy", maxKm: maxKmOf(model), freeDeliveryMin };
  }
  const model = presetModel();
  return { model, source: "preset", maxKm: maxKmOf(model), freeDeliveryMin };
}

/**
 * calcDeliveryFee({model, distanceKm, foodSubtotal, freeDeliveryMin}) — ค่าส่ง 1 เที่ยว (สูตรเดียวกับต้นแบบ)
 *   fee = ลูกค้าจ่าย · riderFee = ไรเดอร์ได้ (เต็มสูตรเสมอ) · shopPays = ร้านออกแทนเมื่อส่งฟรี
 *   freeDeliveryMin > 0 และ foodSubtotal ≥ = ส่งฟรี · foodSubtotal ไม่รู้ (null/undefined) = ไม่ฟรี (fail-closed)
 *   steps = ที่มาของตัวเลขทีละช่วง (fee/preview ใช้ทำ "25 + 1.2×5")
 */
function calcDeliveryFee({ model, distanceKm, foodSubtotal, freeDeliveryMin } = {}) {
  const v = validateDeliveryFeeModel(model);
  if (!v.ok) throw new TypeError(`calcDeliveryFee: สูตรไม่ผ่านด่าน — ${v.errors.map((e) => `${e.field}: ${e.message}`).join(" · ")}`);
  const m = v.model;
  const km = num(distanceKm);
  if (km === null || km < 0) throw new TypeError(`calcDeliveryFee: distanceKm ต้องเป็นตัวเลข ≥ 0 (ได้ ${distanceKm})`);
  const roundedKm = roundKmUp(km);
  const maxKm = maxKmOf(m);
  const free0 = num(freeDeliveryMin) !== null && num(freeDeliveryMin) > 0 ? round2(num(freeDeliveryMin)) : 0;
  const rule = free0 ? { enabled: true, tiers: [{ minSubtotal: free0, maxOff: null }] } : { enabled: false, tiers: [] };
  if (roundedKm > maxKm + EPS) {
    return { fee: null, riderFee: null, shopPays: 0, free: false, outOfRange: true, maxKm, roundedKm, steps: [],
      deliveryDiscount: 0, feeBeforeDiscount: null, feeAfterDiscount: null, deliveryDiscountRule: rule, deliveryDiscountTier: null, nextDeliveryTier: null };
  }
  const steps = [{ kind: "base", fromKm: 0, toKm: m.baseKm, km: Math.min(roundedKm, m.baseKm), perKm: null, amount: m.baseFee }];
  let raw = m.baseFee;
  let floor = m.baseKm;
  for (const b of m.bands) {
    if (roundedKm <= floor + EPS) break;
    const inBand = round1(Math.min(roundedKm, b.toKm) - floor);
    const amount = round2(inBand * b.perKm);
    raw += amount;
    steps.push({ kind: "band", fromKm: floor, toKm: b.toKm, km: inBand, perKm: b.perKm, amount });
    floor = b.toKm;
  }
  const riderFee = roundBahtUp(raw);
  const sub = num(foodSubtotal);
  const reached = free0 > 0 && sub !== null && sub + EPS >= free0;
  const off = reached ? riderFee : 0;
  const fee = round2(riderFee - off);
  const next = !reached && free0 > 0 && sub !== null && riderFee > 0
    ? { minSubtotal: free0, maxOff: null, shortBy: round2(free0 - sub), discount: riderFee, feeAfterDiscount: 0 }
    : null;
  return {
    fee, riderFee, shopPays: off, free: reached && fee === 0, outOfRange: false, maxKm, roundedKm, steps,
    deliveryDiscount: off, feeBeforeDiscount: riderFee, feeAfterDiscount: fee, deliveryDiscountRule: rule,
    deliveryDiscountTier: reached ? rule.tiers[0] : null, nextDeliveryTier: next,
  };
}

// ── ตารางตัวอย่าง (fee/preview · ยกจากต้นแบบ merchantRelay.js › feePreview) ──────────────────
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(round1(n)));

/** ระยะตัวอย่างตั้งต้น = 3/4 ของช่วงแรก · กลางของแต่ละช่วง (ปัดขึ้นจำนวนเต็ม) · ไกลสุด · เกินไกลสุด 1 กม. (ไม่ซ้ำ เรียงขึ้น) */
function defaultDistances(model) {
  const maxKm = maxKmOf(model);
  const pts = [round1(model.baseKm * 0.75)];
  let floor = model.baseKm;
  for (const b of model.bands) {
    const mid = Math.ceil((floor + b.toKm) / 2);
    if (mid > floor && mid < b.toKm) pts.push(mid);
    floor = b.toKm;
  }
  pts.push(maxKm, round1(maxKm + 1));
  return [...new Set(pts.filter((k) => k > 0))].sort((a, b) => a - b);
}

/** ที่มาของตัวเลข "25 + 2×5 + 3×10" */
function howOf(q) {
  if (q.outOfRange) return "out_of_range";
  const parts = q.steps.map((s) => (s.kind === "base" ? fmt(s.amount) : `${fmt(s.km)}×${fmt(s.perKm)}`));
  return parts.length === 1 ? "base" : parts.join(" + ");
}

/**
 * feePreview({deliveryFeeModel, maxKm?, distancesKm?}) → {ok:true, valid, errors, maxKm, stepsLeft, examples:[{km, fee, outOfRange, how, edge?}]}
 *   สูตรที่ร้านกำลังพิมพ์ (ยังไม่บันทึก) · ไม่คิดส่งฟรี (= ค่าส่งเต็มที่ไรเดอร์ได้) · สูตรผิด = errors รายช่อง + examples ว่าง (ไม่ 400)
 */
function feePreview({ deliveryFeeModel, maxKm, distancesKm } = {}) {
  const v = validateDeliveryFeeModel(deliveryFeeModel);
  if (!v.ok) return { ok: true, valid: false, errors: v.errors, maxKm: null, stepsLeft: null, examples: [] };
  const m = v.model;
  const max = maxKmOf(m);
  const errors = [];
  if (maxKm !== undefined && maxKm !== null && Math.abs(Number(maxKm) - max) > EPS) {
    errors.push({ field: "maxKm", message: `ไกลสุด (${maxKm} กม.) ไม่ตรงกับขอบช่วงสุดท้ายของสูตร (${max} กม.)` });
  }
  let dists = defaultDistances(m);
  if (distancesKm !== undefined) {
    const good = Array.isArray(distancesKm) && distancesKm.length >= 1 && distancesKm.length <= 10
      && distancesKm.every((k) => typeof k === "number" && Number.isFinite(k) && k >= 0 && k <= 1000);
    if (!good) errors.push({ field: "distancesKm", message: "ระยะตัวอย่างต้องเป็นตัวเลข 0–1000 กม. 1–10 ค่า" });
    else dists = distancesKm.slice();
  }
  if (errors.length) return { ok: true, valid: false, errors, maxKm: max, stepsLeft: MAX_BANDS - m.bands.length, examples: [] };
  const examples = dists.map((km) => {
    const q = calcDeliveryFee({ model: m, distanceKm: km });
    const row = { km, fee: q.outOfRange ? null : q.riderFee, outOfRange: q.outOfRange, how: howOf(q) };
    if (!q.outOfRange && Math.abs(q.roundedKm - max) < EPS) row.edge = "max";
    return row;
  });
  return { ok: true, valid: true, errors: [], maxKm: max, stepsLeft: MAX_BANDS - m.bands.length, examples };
}

module.exports = {
  MAX_BANDS, DISTANCE_KIND, DEFAULT_MODEL, LEGACY_FLAT_MAX_KM,
  validateDeliveryFeeModel, maxKmOf, resolveDeliveryConfig, calcDeliveryFee, feePreview, defaultDistances, howOf,
  _internals: { num, roundKmUp, roundBahtUp, round1, round2 },
};
