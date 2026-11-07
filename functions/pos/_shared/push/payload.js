// pos/_shared/push/payload.js — รูปข้อความ FCM ของแอปรุ่นใหม่ (ไม่มี OneSignal · DEV-0001 push · pure ไม่มี I/O)
//
// ยกจากบ้านพี่น้อง (buildFcmNative + stringifyValues · `push-pattern-from-sibling.md` §1.2) แล้วแก้ชื่อ
//   Android: data-only · android.priority high · ttl 3 วัน · ❌ ไม่มี notification (แอปวาดเองด้วย notify-kit ⇒ เปิดอยู่/อยู่หลัง/ถูกปิด วาดทางเดียว)
//   iOS    : notification{title,body} + aps.sound 'default' + apns-priority 10 + data เดียวกัน (ระบบวาดเอง)
//            ❌ ไม่มี mutable-content (แอปใหม่ไม่มี notification service extension แล้ว)
//   data   : { src:'shopchamp', v:'1', nid, title, body, channel:'urgent', ...message.data (string ทุกค่า) }
//            key ของเรา (src/v/nid/title/body/channel) ชนะ key ใน message.data เสมอ (แอปใช้กรอง/กันซ้ำ)
//            key ที่ FCM ห้ามใน data (from · notification · message_type · google.* · gcm.*) = ตัดทิ้ง (ปล่อยไว้ = ทั้งก้อนถูกปัด)
//   channel: แอปเก่าใช้ช่อง urgent ของ OneSignal ช่องเดียวทุกจุดส่ง (`APP/src/api/onesignal.js` androidChannelIds.urgent) ⇒ ค่าคงที่ 'urgent'
//   data.sound: ข้อความภาษาไทยที่จุดส่งเดิมแนบมา · ส่งต่อใน data ตามเดิม · แอปเก่าไม่เคยอ่านออกเสียง (ดูแค่ log) ⇒ แอปใหม่ก็ไม่อ่าน
"use strict";

const crypto = require("crypto");

const SRC = "shopchamp";
const VERSION = "1";
const CHANNEL = "urgent";
// 3 วัน · firebase-admin รับ ttl เป็นมิลลิวินาที (number) แล้วแปลงเอง · ส่ง string "259200s" = sendEach ปัดทั้งก้อน (บทเรียนพี่น้อง)
const FCM_TTL = 259200 * 1000;
const FORBIDDEN_DATA_KEY = (k) => k === "from" || k === "notification" || k === "message_type" || /^(google|gcm)\./i.test(k);

/** FCM data ต้องเป็น string ทุกค่า — ตัด undefined/null/"" ทิ้ง ที่เหลือแปลงเป็น string */
function stringifyValues(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

function texts(message) {
  const heading = message.heading == null ? "" : String(message.heading);
  const content = message.content == null ? "" : String(message.content);
  return { heading, body: content || heading };
}

function dataOf(message) {
  const d = message.data;
  return d && typeof d === "object" && !Array.isArray(d) ? d : {};
}

/** nativeData(message, nid) → data ของข้อความ (ใช้ทั้ง 2 แพลตฟอร์ม) */
function nativeData(message, nid) {
  const { heading, body } = texts(message || {});
  const extra = stringifyValues(dataOf(message || {}));
  for (const k of Object.keys(extra)) if (FORBIDDEN_DATA_KEY(k)) delete extra[k];
  return { ...extra, src: SRC, v: VERSION, nid, title: heading, body, channel: CHANNEL };
}

/**
 * buildMessage(message, { platform, nid }) → message ของ firebase-admin (ยังไม่มี token · fcm.js เติมให้)
 *   1 การแจ้งเตือน = nid เดียวทั้ง 2 แพลตฟอร์ม (แอปกันซ้ำด้วยค่านี้)
 */
function buildMessage(message, opts) {
  const o = opts || {};
  const nid = o.nid || crypto.randomUUID();
  const data = nativeData(message || {}, nid);
  if (o.platform === "ios") {
    return {
      notification: { title: data.title, body: data.body },
      apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
      data,
    };
  }
  return { data, android: { priority: "high", ttl: FCM_TTL } };
}

module.exports = { buildMessage, nativeData, stringifyValues, SRC, VERSION, CHANNEL, FCM_TTL };
