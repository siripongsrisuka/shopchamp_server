// pos/_shared/rateLimit.js — ถังนับคำขอในหน่วยความจำ ต่อ instance (DEV-0001 · owner-web-login-design.md §2.6)
//
// ใช้กับ web-login: start 20 ครั้ง / 10 นาที / uid · consume 30 ครั้ง / นาที / IP
// หน้าต่างแบบเลื่อน (เก็บเวลาของแต่ละครั้งในหน้าต่าง) · ไม่มี timer · ล้างคีย์ที่หมดหน้าต่างเองเมื่อคีย์เกินเพดาน
// ความเสี่ยงที่ยอมรับ (เขียนในแบบ): ถังอยู่ต่อ instance (pos maxInstances 100) ⇒ เพดานจริงหลวมกว่าตัวเลข · ถังมีไว้กันค่า read/write ไม่ใช่ยามหลัก
// ❌ ไม่ log คีย์ (คีย์อาจเป็น uid/IP)
"use strict";

const DEFAULT_MAX_KEYS = 10000;

/**
 * makeRateLimiter({max, windowMs, maxKeys?}) → { hit(key, nowMs) → {ok, retryAfterMs}, size() }
 *   hit นับครั้งนี้ก็ต่อเมื่อยังไม่เต็ม (คำขอที่ถูกปัดไม่ต่อเวลาโทษ)
 *   key ว่าง/ไม่ใช่สตริง = ใช้คีย์ "?" (รวมถังเดียว · ไม่ปล่อยผ่าน)
 */
function makeRateLimiter({ max, windowMs, maxKeys = DEFAULT_MAX_KEYS } = {}) {
  if (!Number.isInteger(max) || max < 0) throw new TypeError("rateLimit: max ต้องเป็นจำนวนเต็ม ≥ 0");
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new TypeError("rateLimit: windowMs ต้อง > 0");
  const hits = new Map();

  function prune(nowMs) {
    for (const [k, list] of hits) {
      while (list.length && nowMs - list[0] >= windowMs) list.shift();
      if (!list.length) hits.delete(k);
    }
  }

  function hit(key, nowMs) {
    const k = typeof key === "string" && key !== "" ? key : "?";
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (max === 0) return { ok: false, retryAfterMs: windowMs };
    let list = hits.get(k);
    if (list) while (list.length && now - list[0] >= windowMs) list.shift();
    if (list && list.length >= max) return { ok: false, retryAfterMs: Math.max(0, windowMs - (now - list[0])) };
    if (!list) {
      if (hits.size >= maxKeys) prune(now);
      // ยังเต็มหลังล้าง (คีย์สด ๆ เกินเพดาน) = ทิ้งคีย์เก่าสุดตามลำดับที่ใส่ · กันหน่วยความจำโต ไม่ปล่อยคีย์ใหม่ผ่านเกินเพดานของคีย์ตัวเอง
      while (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
      list = [];
      hits.set(k, list);
    }
    list.push(now);
    return { ok: true, retryAfterMs: 0 };
  }

  return { hit, size: () => hits.size };
}

/** clientIp(req) — `x-forwarded-for` ตัวแรก (ตามแบบ §2.6) → req.ip → "" */
function clientIp(req) {
  const h = req && req.headers ? req.headers["x-forwarded-for"] : undefined;
  const raw = Array.isArray(h) ? h[0] : h;
  if (typeof raw === "string" && raw.trim() !== "") return raw.split(",")[0].trim().slice(0, 64);
  if (req && typeof req.ip === "string" && req.ip) return req.ip.slice(0, 64);
  return "";
}

module.exports = { makeRateLimiter, clientIp, DEFAULT_MAX_KEYS };
