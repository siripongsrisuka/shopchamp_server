// pos/_shared/push/fcm.js — ยิง FCM ตรงด้วย firebase-admin messaging().sendEach ก้อนละ 500 (DEV-0001 push)
//
// ยกจากบ้านพี่น้อง (`push-pattern-from-sibling.md` §1.2) · ส่วนที่เพิ่ม: โหมด dryRun (validate_only ของ FCM · ไม่ถึงเครื่อง)
//   รับ message ต่อแพลตฟอร์มที่ประกอบแล้ว (payload.buildMessage) + targets [{docId, token, platform}] → ผลราย token
//   token ที่ FCM บอกว่าไม่มีแล้ว = dead (ผู้เรียกไปติดธง invalid ต่อ) · ทั้งก้อนล้ม (เน็ต/สิทธิ์) = failed ไม่ใช่ dead
//   (ห้ามฆ่า token เพราะฝั่งเราพัง)
"use strict";

const CHUNK = 500;
const DEAD_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

function defaultMessaging() {
  return require("../../../firebase").admin.messaging(); // lazy · harness/เทสไม่แตะ SDK จริง
}

/**
 * sendFcm({ targets, messageFor, dryRun }, { messaging })
 *   messageFor(platform) → message ที่ไม่มี token
 * → { sent, failed, dead, results:[{docId, ok, dead, error?}] }
 */
async function sendFcm({ targets = [], messageFor, dryRun = false } = {}, deps = {}) {
  const out = { sent: 0, failed: 0, dead: 0, results: [] };
  if (!targets.length) return out;
  const messaging = deps.messaging || defaultMessaging();
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    const msgs = chunk.map((t) => ({ ...messageFor(t.platform), token: t.token }));
    let resp;
    try {
      resp = dryRun ? await messaging.sendEach(msgs, true) : await messaging.sendEach(msgs);
    } catch (e) {
      for (const t of chunk) out.results.push({ docId: t.docId, ok: false, dead: false, error: (e && e.message) || String(e) });
      out.failed += chunk.length;
      continue;
    }
    (resp.responses || []).forEach((r, idx) => {
      const t = chunk[idx];
      if (r.success) {
        out.sent += 1;
        out.results.push({ docId: t.docId, ok: true, dead: false });
        return;
      }
      const code = r.error && (r.error.code || (r.error.errorInfo && r.error.errorInfo.code));
      const dead = DEAD_CODES.has(code);
      out.failed += 1;
      if (dead) out.dead += 1;
      out.results.push({ docId: t.docId, ok: false, dead, error: code || (r.error && r.error.message) || "unknown" });
    });
  }
  return out;
}

module.exports = { sendFcm, CHUNK, DEAD_CODES };
