// pos/routes.js — ทะเบียน route ของ API ใหม่ (ก้อน 4 · DEV-0001) · ที่เดียวที่บอกว่า path ไหนเรียก handler ไหน
//
// path ในตารางนี้ = path หลังชื่อ function · สัญญาเขียน `POST /pos/sale/create` = function `pos` + path `/sale/create`
//   URL จริง: https://asia-southeast2-shopcham-24b0b.cloudfunctions.net/pos/sale/create
// ช่องของแต่ละแถว:
//   contract  ชื่อสัญญา (shopchamp-center/api/<contract>.yaml) · เทส app.test.js ตรวจว่าไฟล์สัญญามีจริงและหัวไฟล์เขียน route ตรงกัน
//   path      path ใน function (POST เท่านั้น)
//   fn        function ที่รับ path นี้ (workloads.js ใช้ segment แรกของ path ตัดสิน) · '*' = ทุก function
//   auth      'shop'    = checkIfAuthenticated → requireShopAccess (ร้านจาก body.shopId)
//             'user'    = checkIfAuthenticated อย่างเดียว (ยังไม่รู้ร้าน · profile.loading หาเองจาก profile)
//             'public'  = ไม่มีด่านตัวตน · ต้องมีชื่ออยู่ใน public-routes.js ด้วย (ตอนนี้ไม่มีสักแถว)
//   load      คืน handler · factory = ต้องเรียกด้วย deps ก่อน (สัญญา display.factory: true)
//   bodyLimit เพดานขนาด body ของแถวนี้ (ไม่ใส่ = 100kb)
"use strict";

const ROUTES = Object.freeze([
  // ping ทุก function รับ (fn '*') ⇒ หลัง deploy ยิงยืนยันได้ทั้ง pos และ pos_heavy
  { contract: "system.ping", path: "/system/ping", fn: "*", auth: "shop", factory: false, load: () => require("./system/ping").ping },
  { contract: "profile.loading", path: "/profile/loading", fn: "pos", auth: "user", factory: true, load: () => require("./profile/loading").loading },
  // บิลรายการเยอะ (ร้านขายส่ง) เกิน 100kb ได้ · doc บิลของ Firestore รับได้ถึง 1 MiB ⇒ เพดานเดียวกับ doc
  { contract: "sale.create", path: "/sale/create", fn: "pos", auth: "shop", factory: true, load: () => require("./sale/create").create, bodyLimit: "1mb" },
  { contract: "sale.get", path: "/sale/get", fn: "pos", auth: "shop", factory: true, load: () => require("./sale/get").get },
  { contract: "sale.void", path: "/sale/void", fn: "pos", auth: "shop", factory: true, load: () => require("./sale/void").void },
  { contract: "sale.amend", path: "/sale/amend", fn: "pos", auth: "shop", factory: true, load: () => require("./sale/amend").amend, bodyLimit: "1mb" },
  { contract: "sale.discardPending", path: "/sale/discard-pending", fn: "pos", auth: "shop", factory: true, load: () => require("./sale/discardPending").discardPending, bodyLimit: "1mb" },
  { contract: "shift.manage", path: "/shift/manage", fn: "pos", auth: "shop", factory: true, load: () => require("./shift/manage").manage },
  { contract: "member.payCredit", path: "/member/pay-credit", fn: "pos", auth: "shop", factory: true, load: () => require("./member/payCredit").payCredit },
]);

module.exports = { ROUTES };
