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
//             'partner' = เซิร์ฟเวอร์คู่ค้า (ScanGo) ไม่ใช่คนในร้าน · ด่าน = กุญแจร่วม header x-scango-platform-key เทียบ secret
//                         SCANGO_SHOPCHAMP_KEY (scango/_partnerAuth.js · ไม่ตั้ง = 503 · ไม่มี/ผิด = 401 no_auth) · ร้านจาก body.externalId
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
  // DEV-0010 อ่านสินค้าของร้านผ่าน API (แทนการอ่าน Firestore ตรงจากแอป · อ่านอย่างเดียว)
  { contract: "stock.sync", path: "/stock/sync", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/syncRead").sync },
  { contract: "stock.findBarcode", path: "/stock/find-barcode", fn: "pos", auth: "shop", factory: true, load: () => require("./stock/syncRead").findBarcode },
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
  // DEV-0003 U2 ชำระเงินอัตโนมัติ (posxpay) ของใบสั่งซื้อบริษัท 4 ชนิด · ยอดจากใบ · server ถามสถานะเองแล้วเปิดของ (_fulfill) · secret COMPANY_POSXPAY_* ผูกที่ workloads.js
  { contract: "company.payRequest", path: "/company/pay-request", fn: "pos", auth: "shop", factory: true, load: () => require("./company/payRequest").payRequest },
  { contract: "company.payStatus", path: "/company/pay-status", fn: "pos", auth: "shop", factory: true, load: () => require("./company/payStatus").payStatus },

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

  // DEV-0003 shopchampoffice · Watcher Console · auth user (คนในทะเบียน watcher/roster ตัดสินที่ handler · root เขียนได้ · passkey ถอดแล้ว 2026-11-11)
  { contract: "office.whoami", path: "/office/whoami", fn: "pos", auth: "user", factory: true, load: () => require("./office/whoami").whoami },
  { contract: "office.rosterGet", path: "/office/roster-get", fn: "pos", auth: "user", factory: true, load: () => require("./office/roster").rosterGet },
  { contract: "office.resolveEmail", path: "/office/resolve-email", fn: "pos", auth: "user", factory: true, load: () => require("./office/roster").resolveEmail },
  { contract: "office.rosterSave", path: "/office/roster-save", fn: "pos", auth: "user", factory: true, load: () => require("./office/roster").rosterSave },
  // DEV-0003 ชำระเงิน/อนุมัติใบสั่งซื้อบริษัท (U4) · root ทำได้ (passkey ถอดแล้ว 2026-11-11) · watcher ดูอย่างเดียว
  // DEV-0003 หน้าผู้ใช้งาน (Pack สั่ง 2026-11-11 · ยังไม่มีการกำหนดสิทธิ์) · ขอเข้าใช้ = คนนอก · ดูรายชื่อ = ทีมงาน · เพิ่ม/เปลี่ยนสถานะ = root
  { contract: "office.accessRequest", path: "/office/access-request", fn: "pos", auth: "user", factory: true, load: () => require("./office/users").accessRequest },
  { contract: "office.userList", path: "/office/user-list", fn: "pos", auth: "user", factory: true, load: () => require("./office/users").userList },
  { contract: "office.userAdd", path: "/office/user-add", fn: "pos", auth: "user", factory: true, load: () => require("./office/users").userAdd },
  { contract: "office.userSetStatus", path: "/office/user-set-status", fn: "pos", auth: "user", factory: true, load: () => require("./office/users").userSetStatus },
  { contract: "office.payList", path: "/office/pay-list", fn: "pos", auth: "user", factory: true, load: () => require("./office/pay").payList },
  { contract: "office.payRecheck", path: "/office/pay-recheck", fn: "pos", auth: "user", factory: true, load: () => require("./office/pay").payRecheck },
  { contract: "office.orderApprove", path: "/office/order-approve", fn: "pos", auth: "user", factory: true, load: () => require("./office/pay").orderApprove },
  { contract: "office.orderCancel", path: "/office/order-cancel", fn: "pos", auth: "user", factory: true, load: () => require("./office/pay").orderCancel },
  // DEV-0003 0d หน้าอุปกรณ์ที่ขาย (admin/hardware · Pack เคาะ 1b 2a 3b 2026-11-11) · ดู = ทีมงาน · แก้ = root · ไม่มี passkey
  { contract: "office.hwCatalog", path: "/office/hw-catalog", fn: "pos", auth: "user", factory: true, load: () => require("./office/hardware").hwCatalog },
  { contract: "office.hwItemSave", path: "/office/hw-item-save", fn: "pos", auth: "user", factory: true, load: () => require("./office/hardware").hwItemSave },
  { contract: "office.hwArrange", path: "/office/hw-arrange", fn: "pos", auth: "user", factory: true, load: () => require("./office/hardware").hwArrange },
  { contract: "office.hwCategorySave", path: "/office/hw-category-save", fn: "pos", auth: "user", factory: true, load: () => require("./office/hardware").hwCategorySave },
  { contract: "office.hwCategoryArrange", path: "/office/hw-category-arrange", fn: "pos", auth: "user", factory: true, load: () => require("./office/hardware").hwCategoryArrange },
  { contract: "office.hwCategoryDelete", path: "/office/hw-category-delete", fn: "pos", auth: "user", factory: true, load: () => require("./office/hardware").hwCategoryDelete },
  { contract: "office.hwShippingSave", path: "/office/hw-shipping-save", fn: "pos", auth: "user", factory: true, load: () => require("./office/hardware").hwShippingSave },
  // DEV-0003 0e ประกาศถึงร้าน (Marketing) · อ่าน = ทีมงาน · เขียน = root (ตัดสินที่ handler) · ไม่ใช้ passkey
  { contract: "office.annList", path: "/office/ann-list", fn: "pos", auth: "user", factory: true, load: () => require("./office/announcement").annList },
  { contract: "office.annSave", path: "/office/ann-save", fn: "pos", auth: "user", factory: true, load: () => require("./office/announcement").annSave },
  { contract: "office.annCancel", path: "/office/ann-cancel", fn: "pos", auth: "user", factory: true, load: () => require("./office/announcement").annCancel },
  { contract: "office.annCategoryList", path: "/office/ann-category-list", fn: "pos", auth: "user", factory: true, load: () => require("./office/announcement").annCategoryList },
  { contract: "office.annCategorySave", path: "/office/ann-category-save", fn: "pos", auth: "user", factory: true, load: () => require("./office/announcement").annCategorySave },
  { contract: "office.annCategoryDelete", path: "/office/ann-category-delete", fn: "pos", auth: "user", factory: true, load: () => require("./office/announcement").annCategoryDelete },
  { contract: "office.annShopFind", path: "/office/ann-shop-find", fn: "pos", auth: "user", factory: true, load: () => require("./office/announcement").annShopFind },
  { contract: "office.annShopTagSet", path: "/office/ann-shop-tag-set", fn: "pos", auth: "user", factory: true, load: () => require("./office/announcement").annShopTagSet },
  // แอปใหม่ 5.00 อ่าน/บันทึกประกาศ · segment announcement = pos · แอปเก่า 3.12 ไม่เรียก
  { contract: "announcement.feed", path: "/announcement/feed", fn: "pos", auth: "shop", factory: true, load: () => require("./announcement/feed").feed },
  { contract: "announcement.seen", path: "/announcement/seen", fn: "pos", auth: "shop", factory: true, load: () => require("./announcement/seen").seen },
  // ── ScanGo (ร้าน Shopchamp ขายบนแอป ScanGo · แบบงาน lanes/dev/source/shopchamp-scango-design.md §เส้นเชื่อม)
  // ขาเข้าจากเซิร์ฟเวอร์ ScanGo (auth 'partner' = กุญแจร่วม header x-scango-platform-key · scango/_partnerAuth.js · ร้านมาจาก body.externalId)
  { contract: "scango.menu", path: "/scango/menu", fn: "pos", auth: "partner", factory: true, load: () => require("./scango/menu").menu },
  // DEV-0009 (Pack เคาะ 1 2026-11-13 · ยึดแบบพี่น้อง /scango/link): ScanGo บอกร้านเปิด/ปิดช่องทาง → shop.scango.enabled
  { contract: "scango.link", path: "/scango/link", fn: "pos", auth: "partner", factory: true, load: () => require("./scango/link").link },
  // ScanGo Order API v1 (DEV-0009 · ยึดแบบพี่น้อง claude/scango/v1/) · auth 'partnerSigned' = ลายเซ็น HMAC (scango/v1/partnerSign.js) ไม่ใช่กุญแจ header
  //   รับใบใหม่ → scangoOrder + push ถึงร้าน (Pack A: ไม่ปัดใบเอง) · เหตุการณ์จากเว็บร้าน ScanGo ขยับสถานะ · ScanGo ถามสถานะ
  { contract: "scango.v1OrderCreate", path: "/scango/v1/orders", fn: "pos", auth: "partnerSigned", factory: true, load: () => require("./scango/v1/orderV1").v1OrderCreate },
  { contract: "scango.v1OrderEvent", path: "/scango/v1/orders/:orderId/events", fn: "pos", auth: "partnerSigned", factory: true, load: () => require("./scango/v1/orderV1").v1OrderEvent },
  { contract: "scango.v1OrderState", path: "/scango/v1/orders/:orderId/state", fn: "pos", auth: "partnerSigned", factory: true, load: () => require("./scango/v1/orderV1").v1OrderState },
  // login เว็บร้าน ScanGo ด้วยบัญชี Shopchamp (Pack เคาะ 2026-11-12): ScanGo ส่ง idToken มาถามว่าเป็นเจ้าของร้านไหน · ถามซ้ำว่ายังเป็นเจ้าของไหม
  { contract: "scango.loginAccount", path: "/scango/settings-login/account", fn: "pos", auth: "partner", factory: true, load: () => require("./scango/settingsLogin").loginAccount },
  { contract: "scango.loginOwnerCheck", path: "/scango/settings-login/owner-check", fn: "pos", auth: "partner", factory: true, load: () => require("./scango/settingsLogin").loginOwnerCheck },
  // รอบ 4 (Pack เคาะ 2026-11-12): แลกรหัสจากแอปร้าน (scango.loginStart) · relay สินค้าจากเว็บร้าน ScanGo (ยึดแบบพี่น้อง · scango/merchantRelay.js)
  { contract: "scango.loginRedeem", path: "/scango/settings-login/redeem", fn: "pos", auth: "partner", factory: true, load: () => require("./scango/settingsLogin").loginRedeem },
  { contract: "scango.merchantProductsList", path: "/scango/merchant/products/list", fn: "pos", auth: "partner", factory: true, load: () => require("./scango/merchantRelay").merchantProductsList },
  { contract: "scango.merchantProductsSet", path: "/scango/merchant/products/set", fn: "pos", auth: "partner", factory: true, load: () => require("./scango/merchantRelay").merchantProductsSet, bodyLimit: "300kb" },
  // ฝั่งแอปร้าน (auth 'shop' · path ขึ้นต้น /scango/shop/ แยกจากขาเข้าของ ScanGo)
  { contract: "scango.orderList", path: "/scango/shop/order-list", fn: "pos", auth: "shop", factory: true, load: () => require("./scango/shop/orderList").orderList },
  // DEV-0009 สเปกข้อ 6 (Pack ผ่าน 2026-11-14): ร้านกดรับใบในแอป → accepted + ยิง OrderEvent v1 'accepted' ไป ScanGo (v1/eventOut.js · ลายเซ็น HMAC กุญแจ SCANGO_SHOPCHAMP_KEY)
  { contract: "scango.orderAccept", path: "/scango/shop/order-accept", fn: "pos", auth: "shop", factory: true, load: () => require("./scango/shop/orderAccept").orderAccept },
  // ไทล์ ScanGo หน้าแรก (รอบ 4 · ยึดแบบพี่น้อง settings-login/status · start): เลือกหน้าแนะนำ/เว็บร้าน/หน้าอธิบาย · รหัสเข้าเว็บร้านใช้ครั้งเดียว
  { contract: "scango.loginStatus", path: "/scango/shop/login-status", fn: "pos", auth: "shop", factory: true, load: () => require("./scango/shop/loginStatus").loginStatus },
  { contract: "scango.loginStart", path: "/scango/shop/login-start", fn: "pos", auth: "shop", factory: true, load: () => require("./scango/shop/loginStart").loginStart },
]);

module.exports = { ROUTES };
