// pos/_shared/push/send.js — ตัวส่งแจ้งเตือนฝั่ง server ของ API ใหม่ (DEV-0001 push · แอปใหม่ไม่มี OneSignal)
//
// sendPush({ to, heading, content, data }, deps) → { devices, sent, failed, dead, invalidated, dryRun }
//   หาเครื่อง (tokenStore.findTargets · เฉพาะแอปใหม่ client native) → ประกอบรูปต่อแพลตฟอร์ม (payload) → FCM sendEach (fcm)
//   → token ตาย = ติดธง invalid (ไม่ลบ doc)
//   🔒 ไม่ throw เด็ดขาด · ไม่มีเครื่อง = จบเงียบ · ผู้เรียกคือ handler ที่เขียนสำเร็จไปแล้ว ⇒ แจ้งเตือนพังห้ามทำให้คำตอบพัง
// 2 ท่อขนานช่วงเปลี่ยนผ่าน (Pack เลือกทาง 1 · 2026-11-07): ① FCM หาเครื่องแอปใหม่ (ไฟล์นี้) ② OneSignal หาเครื่องแอปเก่า (onesignalPipe.js · ลบได้ทั้งไฟล์)
//   ไม่แตะ legacy `apis/onesignal.js` · ท่อหนึ่งพังไม่กระทบอีกท่อ
// dryRun: env `PUSH_DRY_RUN=1` หรือ deps.dryRun = ส่งแบบ validate_only (FCM ตรวจข้อความ+token แต่ไม่ถึงเครื่อง · ใช้เทส local)
"use strict";

const crypto = require("crypto");
const { findTargets, markInvalid } = require("./tokenStore");
const { buildMessage } = require("./payload");
const { sendFcm } = require("./fcm");
const { sendOneSignal } = require("./onesignalPipe"); // 🗑️ ลบพร้อมไฟล์เมื่อยกเลิก OneSignal

const log = (deps) => deps.log || console;

async function sendPush(message, deps = {}) {
  const [fcm, onesignal] = await Promise.all([sendFcmPipe(message, deps), sendOneSignal(message, deps)]);
  return { ...fcm, onesignal };
}

async function sendFcmPipe(message, deps = {}) {
  const out = { devices: 0, sent: 0, failed: 0, dead: 0, invalidated: 0, dryRun: false };
  try {
    if (!message || typeof message !== "object") return out;
    const dryRun = deps.dryRun === true || process.env.PUSH_DRY_RUN === "1";
    out.dryRun = dryRun;
    const targets = await findTargets(message.to, deps);
    out.devices = targets.length;
    if (!targets.length) return out;
    const nid = (deps.uuid || crypto.randomUUID)();
    const built = { android: buildMessage(message, { platform: "android", nid }), ios: buildMessage(message, { platform: "ios", nid }) };
    const r = await sendFcm({ targets, messageFor: (p) => built[p], dryRun }, deps);
    out.sent = r.sent;
    out.failed = r.failed;
    out.dead = r.dead;
    const dead = r.results.filter((x) => x.dead).map((x) => x.docId);
    if (dead.length && !dryRun) out.invalidated = await markInvalid(dead, "fcm_dead", deps);
    const errs = [...new Set(r.results.filter((x) => !x.ok).map((x) => x.error))].slice(0, 5);
    log(deps).info(`push ${message.to && message.to.kind} devices=${out.devices} sent=${out.sent} failed=${out.failed} dead=${out.dead}${dryRun ? " dryRun" : ""}${errs.length ? " errors=" + errs.join(",") : ""}`);
    return out;
  } catch (e) {
    log(deps).warn(`push failed ${(e && e.message) || e}`);
    return { ...out, error: (e && e.message) || String(e) };
  }
}

module.exports = { sendPush };
