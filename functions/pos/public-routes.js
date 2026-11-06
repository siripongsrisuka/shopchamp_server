// pos/public-routes.js — ทะเบียน route ที่ไม่มีด่านตัวตน (ก้อน 4 · DEV-0001 · ยกท่าจาก claudeAuth.mount.test ของพี่น้อง)
//
// กติกา (เทส app.test.js บังคับ):
//   ① แถวใน routes.js ที่ auth = 'public' ต้องมีชื่อในรายการนี้ · ไม่มี = แดง
//   ② ชื่อในรายการนี้ต้องมีแถวใน routes.js ที่ auth = 'public' · ไม่มี = แดง (ทะเบียนค้าง)
//   ③ ทุก route ที่ไม่อยู่ในรายการ ยิงโดยไม่มี token ต้องได้ 401 no_auth
// เพิ่มแถว = ต้องเขียนเหตุผลข้างแถว และ Pack เห็นใน commit
// ตอนนี้ไม่มี route สาธารณะ (webhook ของเกตเวย์มาในก้อน 7)
"use strict";

const PUBLIC_ROUTES = Object.freeze([]);

module.exports = { PUBLIC_ROUTES };
