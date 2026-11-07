// pos/webLogin/sharedAccounts.js — บัญชีกลางที่เว็บเจ้าของร้านรุ่นเดิมใช้ login (DEV-0001 · owner-web-login-design.md §8 SHARED_EMAILS)
//
// ที่มา: เว็บ `src/screens/HomeScreen.js:16-21` (owner@ … owner10@) · `src/App.js:60` (anonymoususer@) · รหัสผ่านอยู่ในโค้ดเว็บ ⇒ ใครก็เป็นบัญชีพวกนี้ได้
// ใช้: web-login start/approve ปัดบัญชีกลาง 403 shared_account · log `pos shopAccess deny` ติดป้าย shared (§11 ข้อ 12)
// รายชื่อเดียวกับเว็บ `src/db/sharedFirebase.js` › SHARED_EMAILS · เปลี่ยน = แก้แบบ §8 ก่อน
"use strict";

const SHARED_EMAILS = Object.freeze([
  "anonymoususer@gmail.com",
  "owner@gmail.com",
  ...Array.from({ length: 9 }, (_, i) => `owner${i + 2}@gmail.com`),
]);
const SET = new Set(SHARED_EMAILS);

/** isSharedEmail(email) — เทียบแบบตัดช่องว่าง + ตัวเล็ก · ไม่ใช่สตริง = false */
function isSharedEmail(email) {
  return typeof email === "string" && SET.has(email.trim().toLowerCase());
}

module.exports = { SHARED_EMAILS, isSharedEmail };
