// pos/sale/getSerialize — แปลงเอกสาร Firestore เป็น JSON ที่ client อ่านได้ (ใช้โดย pos/sale/get · ก้อน 4 · DEV-0001)
//
// Timestamp (มี toDate) / Date → ISO string · DocumentReference → path · GeoPoint → {latitude, longitude}
// วันที่อ่านไม่ออก → null · ตัวเลขไม่จำกัดค่า (NaN/Infinity ในบิลเก่า) → null แบบเดียวกับ JSON.stringify แต่ชัดเจน
// ❌ ไม่ throw · ไม่ตามวงอ้างกลับ (กัน object แปลกจาก SDK)
"use strict";

const MAX_DEPTH = 32;

function isPlainObject(v) {
  if (v === null || typeof v !== "object") return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function isoOf(d) {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

function toClientJson(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const t = typeof value;
  if (t === "number") return Number.isFinite(value) ? value : null;
  if (t === "string" || t === "boolean") return value;
  if (t === "bigint") return value.toString();
  if (t !== "object") return undefined; // function / symbol
  if (value instanceof Date) return isoOf(value);
  if (typeof value.toDate === "function") {
    try { return isoOf(value.toDate()); } catch (_) { return null; }
  }
  if (depth >= MAX_DEPTH || seen.has(value)) return null;
  if (!Array.isArray(value) && !isPlainObject(value)) {
    if (typeof value.path === "string" && "firestore" in value) return value.path;
    if (typeof value.latitude === "number" && typeof value.longitude === "number") {
      return { latitude: value.latitude, longitude: value.longitude };
    }
  }
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((v) => { const c = toClientJson(v, depth + 1, seen); return c === undefined ? null : c; });
  } else {
    out = {};
    for (const k of Object.keys(value)) {
      const c = toClientJson(value[k], depth + 1, seen);
      if (c !== undefined) out[k] = c;
    }
  }
  seen.delete(value);
  return out;
}

module.exports = { toClientJson };
