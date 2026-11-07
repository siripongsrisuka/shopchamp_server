// pos/public-routes.js — ทะเบียน route ที่ไม่มีด่านตัวตน (ก้อน 4 · DEV-0001 · ยกท่าจาก claudeAuth.mount.test ของพี่น้อง)
//
// กติกา (เทส app.test.js บังคับ):
//   ① แถวใน routes.js ที่ auth = 'public' ต้องมีชื่อในรายการนี้ · ไม่มี = แดง
//   ② ชื่อในรายการนี้ต้องมีแถวใน routes.js ที่ auth = 'public' · ไม่มี = แดง (ทะเบียนค้าง)
//   ③ ทุก route ที่ไม่อยู่ในรายการ ยิงโดยไม่มี token ต้องได้ 401 no_auth
// เพิ่มแถว = ต้องเขียนเหตุผลข้างแถว และ Pack เห็นใน commit
// webhook ของเกตเวย์อยู่ที่ pos_gateway (app แยก) ไม่ใช่ทะเบียนนี้
"use strict";

const PUBLIC_ROUTES = Object.freeze([
  // DEV-0001 (Pack เคาะ §11 ข้อ 2 · owner-web-login-design.md §2.1): เว็บแลกรอบ login เป็น custom token ตอนที่ยังไม่มีตัวตน
  //   ยามแทน token = secret 32 ไบต์ (เก็บแค่ sha256 · เทียบ timingSafeEqual) + ผนึก HMAC ของ doc + อายุ 120 วิ + ใช้ครั้งเดียวใน transaction
  //   + ถัง 30 ครั้ง/นาที/IP · token ออกให้ startedBy ที่ผนึกไว้ตอน start (คนที่ถือ ID token ของแอป) เท่านั้น
  "/web-login/consume",
]);

module.exports = { PUBLIC_ROUTES };
