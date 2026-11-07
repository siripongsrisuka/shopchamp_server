// pos/_shared/push/notify.js — ทางที่ handler ของ API ใหม่ใช้ส่งแจ้งเตือนหลังเขียนสำเร็จ (DEV-0001 push)
//
// notify(deps, messages) — เรียกหลัง transaction commit แล้วเท่านั้น และเฉพาะครั้งที่ไม่ใช่ส่งซ้ำ (duplicate = ไม่แจ้งซ้ำ)
//   messages = 1 ตัวหรือ array ของ { to, heading, content, data } (รูปผู้รับ = tokenStore.findTargets)
//   ข้อความที่ไม่มีผู้รับ (ids ว่าง · shopId ว่าง) = ตัดทิ้งก่อนเรียก ⇒ ร้านที่ไม่ได้ตั้งผู้รับ = ไม่เรียกตัวส่งเลย
//   ตัวส่ง = deps.push (stub ใน case ของ harness · บันทึก calls.push) · ไม่ส่ง = sendPush ตัวจริง
//   รอผลไม่เกิน TIMEOUT_MS (Cloud Functions ลด CPU หลังตอบ ⇒ ส่งก่อนตอบ) · พัง/ช้า = log แล้วไปต่อ ไม่กระทบคำตอบ
"use strict";

const { depOr } = require("../deps");

const TIMEOUT_MS = 4000;

function hasRecipients(m) {
  const to = m && m.to;
  if (!to || typeof to !== "object") return false;
  const ids = Array.isArray(to.ids) ? to.ids.filter((x) => typeof x === "string" && x !== "") : [];
  if (to.kind === "shop") return typeof to.shopId === "string" && to.shopId !== "";
  if (to.kind === "staff") return typeof to.shopId === "string" && to.shopId !== "" && ids.length > 0;
  if (to.kind === "people") return ids.length > 0;
  return false;
}

/** ids ของผู้รับจากรายชื่อใน doc ร้าน (notiShift ฯลฯ) · ไม่ใช่ array = [] · ตัดค่าว่าง/ซ้ำ */
function idsOf(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((x) => typeof x === "string" && x !== ""))];
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((resolve) => { t = setTimeout(() => resolve({ timeout: true }), ms); })]).finally(() => clearTimeout(t));
}

async function notify(deps, messages) {
  const list = (Array.isArray(messages) ? messages : [messages]).filter(hasRecipients);
  if (!list.length) return [];
  let fn;
  try {
    fn = depOr(deps, "push", null) || require("./send").sendPush;
  } catch (e) {
    console.warn(`push skipped ${(e && e.message) || e}`);
    return [];
  }
  const out = [];
  for (const m of list) {
    try {
      out.push(await withTimeout(Promise.resolve(fn(m)), TIMEOUT_MS));
    } catch (e) {
      console.warn(`push failed ${(e && e.message) || e}`);
      out.push({ error: (e && e.message) || String(e) });
    }
  }
  return out;
}

module.exports = { notify, idsOf, hasRecipients, TIMEOUT_MS };
