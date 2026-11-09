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
//             'public'  = ไม่มีด่านตัวตน · ต้องมีชื่ออยู่ใน public-routes.js ด้วย (ตอนนี้ 1 แถว: /web-login/consume)
//   access    (เฉพาะ auth 'shop') ไม่ใส่ = requireShopAccess ปกติ · "reportRead" = requireReportReadAccess (legacy owner-web parity
//             ชั่วคราว · ให้ได้เฉพาะ contract report.* · app.js ปัดตอนสร้าง app ถ้าผูกที่อื่น)
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
  { contract: "sale.issueTaxInvoice", path: "/sale/issue-tax-invoice", fn: "pos", auth: "shop", factory: true, load: () => require("./sale/issueTaxInvoice").issueTaxInvoice },
  { contract: "shift.manage", path: "/shift/manage", fn: "pos", auth: "shop", factory: true, load: () => require("./shift/manage").manage },
  // DEV-0002: เว็บถามกะที่เปิดอยู่ก่อนรับชำระเงินเซ็นเป็นเงินสด (อ่านอย่างเดียว)
  { contract: "shift.openList", path: "/shift/open-list", fn: "pos", auth: "shop", factory: true, load: () => require("./shift/openList").openList },
  { contract: "member.payCredit", path: "/member/pay-credit", fn: "pos", auth: "shop", factory: true, load: () => require("./member/payCredit").payCredit },

  // ก้อน 9a สต๊อก · segment stock = pos · stock-repair = pos_heavy (อ่านสินค้าทั้งร้าน)
  { contract: "stock.receive", path: "/stock/receive", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/receive").receive, bodyLimit: "1mb" },
  { contract: "stock.receiveEdit", path: "/stock/receive-edit", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/receiveEdit").receiveEdit },
  { contract: "stock.requisition", path: "/stock/requisition", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/requisition").requisition, bodyLimit: "1mb" },
  { contract: "stock.linkCreate", path: "/stock/link-create", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/link").linkCreate },
  { contract: "stock.linkUpdate", path: "/stock/link-update", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/link").linkUpdate },
  { contract: "stock.linkDelete", path: "/stock/link-delete", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/link").linkDelete },
  { contract: "stock.productSave", path: "/stock/product-save", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/productSave").productSave },
  { contract: "stock.productDelete", path: "/stock/product-delete", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/productDelete").productDelete },
  { contract: "stock.adjust", path: "/stock/adjust", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/adjust").adjust },
  { contract: "stock.supplier", path: "/stock/supplier", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/supplier").supplier },
  { contract: "stock.uploadOpen", path: "/stock/upload-open", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/uploadOpen").uploadOpen },
  { contract: "stock.orderCreate", path: "/stock/order-create", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/orderCreate").orderCreate },
  { contract: "stock.reorder", path: "/stock/reorder", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/reorder").reorder, bodyLimit: "1mb" },
  // DEV-0008 จอความเคลื่อนไหวสต๊อก (premium · อ่านอย่างเดียว)
  { contract: "stock.journalDays", path: "/stock/journal-days", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/moveRead").journalDays },
  { contract: "stock.moveList", path: "/stock/move-list", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/moveRead").moveList },
  { contract: "stock.cloneRepair", path: "/stock-repair/clone", fn: "pos_heavy", auth: "shop", factory: true, load: () => require("./stock/cloneRepair").cloneRepair },

  // ก้อน 9b สมาชิกและสินค้า
  { contract: "member.create", path: "/member/create", fn: "pos", auth: "shop", factory: true, load: () => require("./member/create").create },
  { contract: "member.update", path: "/member/update", fn: "pos", auth: "shop", factory: true, load: () => require("./member/update").update },
  { contract: "member.redeemPoint", path: "/member/redeem-point", fn: "pos", auth: "shop", factory: true, load: () => require("./member/redeemPoint").redeemPoint },
  { contract: "member.delete", path: "/member/delete", fn: "pos", auth: "shop", factory: true, load: () => require("./member/delete").delete },
  { contract: "member.rebuildIndex", path: "/member/rebuild-index", fn: "pos", auth: "shop", factory: true, load: () => require("./member/rebuildIndex").rebuildIndex },
  { contract: "promotion.save", path: "/promotion/save", fn: "pos", auth: "shop", factory: true, load: () => require("./promotion/save").save },
  { contract: "promotion.delete", path: "/promotion/delete", fn: "pos", auth: "shop", factory: true, load: () => require("./promotion/delete").delete },
  { contract: "promotion.setStatus", path: "/promotion/set-status", fn: "pos", auth: "shop", factory: true, load: () => require("./promotion/setStatus").setStatus },
  { contract: "product.saveCentral", path: "/product/save-central", fn: "pos", auth: "shop", factory: true, load: () => require("./product/saveCentral").saveCentral },
  { contract: "priceTag.create", path: "/price-tag/create", fn: "pos", auth: "shop", factory: true, load: () => require("./priceTag/create").create, bodyLimit: "1mb" },

  // ก้อน 9c ร้านและพนักงาน · staff.checkIn กับ profile.manage = auth user (ตัดสินร้านใน handler)
  { contract: "shop.update", path: "/shop/update", fn: "pos", auth: "shop", factory: true, load: () => require("./shopStaff/shopUpdate").shopUpdate },
  { contract: "staff.manage", path: "/staff/manage", fn: "pos", auth: "shop", factory: true, load: () => require("./shopStaff/staffManage").staffManage },
  { contract: "staff.checkIn", path: "/staff/check-in", fn: "pos", auth: "user", factory: true, load: () => require("./shopStaff/checkIn").checkIn },
  // #13 ตรวจรหัสแคชเชียร์ที่ server (แทนเทียบในเครื่อง) · ผิดเกินกำหนดล็อกชั่วคราว (ใบนับผิด cashierCodeGuard)
  { contract: "staff.verifyCashierCode", path: "/staff/verify-cashier-code", fn: "pos", auth: "shop", factory: true, load: () => require("./shopStaff/verifyCashierCode").verifyCashierCode },
  { contract: "expense.manage", path: "/expense/manage", fn: "pos", auth: "shop", factory: true, load: () => require("./shopStaff/expenseManage").expenseManage },
  { contract: "expenseReport.manage", path: "/expense-report/manage", fn: "pos", auth: "shop", factory: true, load: () => require("./shopStaff/expenseReportManage").expenseReportManage },
  { contract: "profile.manage", path: "/profile/manage", fn: "pos", auth: "user", factory: true, load: () => require("./shopStaff/profileManage").profileManage },
  // ก้อน 10 รอบ 2c: LINE token เข้าที่ลับ + สำเนาเดิม (LS-033) · เข้าครั้งแรกของร้านรุ่นแรก (LD-029 · auth user ตัดสินเจ้าของจาก shop.shopId == uid)
  { contract: "shop.lineSettings", path: "/shop/line-settings", fn: "pos", auth: "shop", factory: true, load: () => require("./shopStaff/lineSettings").lineSettings },
  { contract: "profile.claimLegacyShop", path: "/profile/claim-legacy-shop", fn: "pos", auth: "user", factory: true, load: () => require("./shopStaff/claimLegacyShop").claimLegacyShop },
  // ก้อน 10 รอบ 2a: จุดขายพร้อม doc shift ใน transaction เดียว · ย้ายโครงร้านรุ่นแรก (U20)
  { contract: "pos.manage", path: "/pos/manage", fn: "pos", auth: "shop", factory: true, load: () => require("./shopStaff/posManage").posManage },
  { contract: "shop.migrateLegacy", path: "/shop/migrate-legacy", fn: "pos", auth: "shop", factory: true, load: () => require("./shopStaff/shopMigrateLegacy").shopMigrateLegacy },

  // ก้อน 9d บริษัท
  { contract: "company.packageOrder", path: "/company/package-order", fn: "pos", auth: "shop", factory: true, load: () => require("./company/packageOrder").packageOrder },
  { contract: "company.hardwareOrder", path: "/company/hardware-order", fn: "pos", auth: "shop", factory: true, load: () => require("./company/hardwareOrder").hardwareOrder },
  { contract: "company.imageOrder", path: "/company/image-order", fn: "pos", auth: "shop", factory: true, load: () => require("./company/imageOrder").imageOrder },
  { contract: "company.scanLoginApprove", path: "/company/scan-login-approve", fn: "pos", auth: "user", factory: true, load: () => require("./company/scanLoginApprove").scanLoginApprove },
  { contract: "company.deleteAccount", path: "/company/delete-account", fn: "pos", auth: "user", factory: true, load: () => require("./company/deleteAccount").deleteAccount },
  { contract: "company.shopCreate", path: "/company/shop-create", fn: "pos", auth: "user", factory: true, load: () => require("./company/shopCreate").shopCreate },

  // DEV-0001 push: แอปรุ่นใหม่ไม่มี OneSignal (Pack เคาะ 2026-11-07) · ลงทะเบียน FCM token ต่อเครื่อง · ออกร้าน/ออกระบบ = เลิกรับ
  { contract: "device.registerPushToken", path: "/device/register-push-token", fn: "pos", auth: "shop", factory: true, load: () => require("./device/registerPushToken").registerPushToken },
  { contract: "device.signOutPush", path: "/device/sign-out-push", fn: "pos", auth: "user", factory: true, load: () => require("./device/signOutPush").signOutPush },

  // ก้อน 9e รายงาน · อ่านอย่างเดียว · pos_heavy
  //   access "reportRead" = ด่านร้านแบบ legacy owner-web parity ชั่วคราว (auth.js › resolveReportReadAccess · Pack เคาะ 2026-11-07)
  { contract: "report.billList", path: "/report/bill-list", fn: "pos_heavy", auth: "shop", access: "reportRead", factory: true, load: () => require("./report/billList").billList },
  { contract: "report.salesTotals", path: "/report/sales-totals", fn: "pos_heavy", auth: "shop", access: "reportRead", factory: true, load: () => require("./report/salesTotals").salesTotals },
  { contract: "report.taxInvoices", path: "/report/tax-invoices", fn: "pos_heavy", auth: "shop", access: "reportRead", factory: true, load: () => require("./report/taxInvoices").taxInvoices },
  { contract: "report.duplicateNumbers", path: "/report/duplicate-numbers", fn: "pos_heavy", auth: "shop", access: "reportRead", factory: true, load: () => require("./report/duplicateNumbers").duplicateNumbers },
  { contract: "report.shiftHistory", path: "/report/shift-history", fn: "pos_heavy", auth: "shop", access: "reportRead", factory: true, load: () => require("./report/shiftHistory").shiftHistory },
  // DEV-0002 เว็บเจ้าของร้าน: ยอดแยกมิติ 14 จอรายงาน · บิลของสมาชิก
  { contract: "report.breakdown", path: "/report/breakdown", fn: "pos_heavy", auth: "shop", access: "reportRead", factory: true, load: () => require("./report/breakdown").breakdown },
  { contract: "report.memberBills", path: "/report/member-bills", fn: "pos_heavy", auth: "shop", access: "reportRead", factory: true, load: () => require("./report/memberBills").memberBills },

  // ก้อน 9f เว็บแฟรนไชส์ (DEV-0002) · auth user (ไม่มีร้านใน body · ตัดสินสิทธิ์จาก doc แฟรนไชส์ใน handler) · segment franchise = pos · franchise-report = pos_heavy
  { contract: "franchise.list", path: "/franchise/list", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/read").list },
  { contract: "franchise.get", path: "/franchise/get", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/read").get },
  { contract: "franchise.create", path: "/franchise/create", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/franchise").create },
  { contract: "franchise.profileUpdate", path: "/franchise/profile-update", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/franchise").profileUpdate },
  { contract: "franchise.categorySave", path: "/franchise/category-save", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/franchise").categorySave, bodyLimit: "1mb" },
  { contract: "franchise.warehouseList", path: "/franchise/warehouse-list", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/read").warehouseList },
  { contract: "franchise.warehouseSave", path: "/franchise/warehouse-save", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/warehouse").warehouseSave },
  { contract: "franchise.warehouseDelete", path: "/franchise/warehouse-delete", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/warehouse").warehouseDelete },
  { contract: "franchise.linkList", path: "/franchise/link-list", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/read").linkList },
  { contract: "franchise.linkSave", path: "/franchise/link-save", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/link").linkSave },
  { contract: "franchise.linkDelete", path: "/franchise/link-delete", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/link").linkDelete },
  { contract: "franchise.branchList", path: "/franchise/branch-list", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/read").branchList },
  { contract: "franchise.branchFind", path: "/franchise/branch-find", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/branch").branchFind },
  { contract: "franchise.branchAttach", path: "/franchise/branch-attach", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/branch").branchAttach },
  { contract: "franchise.staffFind", path: "/franchise/staff-find", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/staff").staffFind },
  { contract: "franchise.staffSave", path: "/franchise/staff-save", fn: "pos", auth: "user", factory: true, load: () => require("./franchise/staff").staffSave },
  { contract: "franchise.billList", path: "/franchise-report/bill-list", fn: "pos_heavy", auth: "user", factory: true, load: () => require("./franchise/billList").billList },
  // DEV-0002 Pack เคาะ 2026-11-07: ยอดแฟรนไชส์ใช้สูตรกลาง (logic.franchiseBreakdown = salesBreakdown ต่อสาขา)
  { contract: "franchise.breakdown", path: "/franchise-report/breakdown", fn: "pos_heavy", auth: "user", factory: true, load: () => require("./franchise/breakdown").breakdown },

  // DEV-0001 ปุ่มรายงานเปิดเว็บในแอป · ลิงก์ login ใช้ครั้งเดียว (owner-web-login-design.md §2) · start/approve = ID token ของแอป · consume = public (ลงทะเบียนใน public-routes.js)
  { contract: "webLogin.start", path: "/web-login/start", fn: "pos", auth: "user", factory: true, load: () => require("./webLogin/webLogin").start },
  { contract: "webLogin.approve", path: "/web-login/approve", fn: "pos", auth: "user", factory: true, load: () => require("./webLogin/webLogin").approve },
  { contract: "webLogin.consume", path: "/web-login/consume", fn: "pos", auth: "public", factory: true, load: () => require("./webLogin/webLogin").consume },

  // DEV-0003 shopchampoffice · Watcher Console · auth user (คนในทะเบียน watcher/roster ตัดสินที่ handler · root เขียนได้ + passkey)
  { contract: "office.whoami", path: "/office/whoami", fn: "pos", auth: "user", factory: true, load: () => require("./office/whoami").whoami },
  { contract: "office.rosterGet", path: "/office/roster-get", fn: "pos", auth: "user", factory: true, load: () => require("./office/roster").rosterGet },
  { contract: "office.resolveEmail", path: "/office/resolve-email", fn: "pos", auth: "user", factory: true, load: () => require("./office/roster").resolveEmail },
  { contract: "office.rosterSave", path: "/office/roster-save", fn: "pos", auth: "user", factory: true, load: () => require("./office/roster").rosterSave },
  { contract: "office.passkeyRegisterOptions", path: "/office/passkey-register-options", fn: "pos", auth: "user", factory: true, load: () => require("./office/passkey").registerOptions },
  { contract: "office.passkeyRegisterVerify", path: "/office/passkey-register-verify", fn: "pos", auth: "user", factory: true, load: () => require("./office/passkey").registerVerify },
  { contract: "office.passkeyAssertOptions", path: "/office/passkey-assert-options", fn: "pos", auth: "user", factory: true, load: () => require("./office/passkey").assertOptions },
  { contract: "office.passkeyAssertVerify", path: "/office/passkey-assert-verify", fn: "pos", auth: "user", factory: true, load: () => require("./office/passkey").assertVerify },
]);

module.exports = { ROUTES };
