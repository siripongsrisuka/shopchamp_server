// pos/company/shopTemplate — แม่แบบร้านใหม่ฝั่ง server (ก้อน 9d DEV-0001) · คัดจากแอป main3 ตามตัว
//
// ที่มา (เทส shopTemplate.test.js เทียบกับไฟล์ใน main3 ทุกครั้งที่รัน · ต่าง = แดง):
//   src/config/initialShop.js (+ initialCoupon · initialPoint · initialSoundPlayer · initialTax · mainImage.discount*)
//   src/config/initialPos.js · src/config/initialShift.js · src/config/initialVip.js · src/config/initialRights.js
// ทำไมต้องประกอบที่ server: เดิมแอปเขียน doc ร้านทั้งก้อนเอง ⇒ เครื่องที่แก้โค้ดตั้ง `vip` หมดอายุปี 2099 หรือ `scShopId` ซ้ำได้
//   ทางใหม่แอปส่งได้แค่ชื่อ เบอร์ ที่อยู่ และข้อมูลเครื่อง (CompanyShopCreateRequest strict)
// วันที่ของแม่แบบเดิมคือ `new Date(2011, 0, 1, 0, 0, 0, 0)` ตามนาฬิกาเครื่อง (ไทย) = 2010-12-31T17:00:00Z
"use strict";

const { INITIAL_RIGHTS } = require("../_shared/auth");

const OLD_EPOCH_ISO = "2010-12-31T17:00:00.000Z"; // new Date(2011,0,1) ในเครื่องไทย

const COUPON_IMAGES = Object.freeze({
  discountten: "https://firebasestorage.googleapis.com/v0/b/shopcham-24b0b.appspot.com/o/webP%2Fdiscount-10-120224-65c9983e73647.webp?alt=media&token=d335bb60-c861-4ec8-9bef-6782495f946c",
  discounttweenty: "https://firebasestorage.googleapis.com/v0/b/shopcham-24b0b.appspot.com/o/webP%2Fdiscount-20-120224-65c9983e7115f.webp?alt=media&token=8130774f-c6de-4dd5-b07c-ac45764344a5",
  discountfifty: "https://firebasestorage.googleapis.com/v0/b/shopcham-24b0b.appspot.com/o/webP%2Fdiscount-50-120224-65c9983f7dd84.webp?alt=media&token=fef33e3f-da37-4594-84af-6999ef3247a3",
  discounthundred: "https://firebasestorage.googleapis.com/v0/b/shopcham-24b0b.appspot.com/o/webP%2Fdiscount-100-120224-65c9983f80dfb.webp?alt=media&token=18d14bb6-7dfa-4b60-81fc-df80da4f91d3",
});

// ตำแหน่ง 3 แบบของร้านใหม่ (initialShop.js position[]) · rights เป็นข้อความ
const OWNER_POSITION_RIGHTS = [
  "100", "101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "111", "112", "113",
  "114", "115", "116", "117", "118", "119", "120", "121", "122", "123", "124", "125", "126", "127",
  "128", "129", "130", "131", "132", "133", "134", "135", "136", "137", "138", "139", "140", "141",
  "142", "143", "144", "145", "146", "147", "148", "149", "150", "151", "152", "153", "154", "155",
  "501", "502", "503", "504", "505", "506", "507", "508", "509", "510", "511", "512", "513", "514",
  "515", "516", "517", "518", "519", "520", "521", "522", "523", "524", "525", "526",
  "901",
];
const MANAGER_POSITION_RIGHTS = [
  "100", "101", "102", "103", "104", "105", "106", "107",
  "503", "504", "505", "506", "507", "509", "510", "511", "512", "515", "516", "517", "519", "520", "523",
];

// ช่องว่างท้ายบรรทัด 2 และ 4 มีจริงในต้นฉบับ (template literal) · เขียนเป็น \n ให้เห็นชัดและไม่ถูกตัวแก้ไฟล์ตัดทิ้ง
const RECEIPT_HEADER =
  "บริษัท เฮง เฮง จำกัด\n" +
  "      444 Siam Aquare Soi 7, Rama 1 Road, \n" +
  "      Pathumwan,Bangkok, 10330 Thailand\n" +
  "      TAX ID : 0105569384059 \n" +
  "      ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ";

/** ส่วนของ initialShop ที่ไม่มีวันที่และไม่ขึ้นกับคนสร้าง (ตัวใหม่ทุกครั้ง ⇒ ไม่มีใครถือ reference ร่วม) */
function staticShopPart() {
  return {
    POSs: [],
    address: "",
    attendance: [],
    branch: 1,
    humanResource: [{ email: "", name: "", notification: true, position: ["001"], status: "active", tel: "" }],
    imageUrl: [],
    name: "",
    payment: [],
    position: [
      { id: "001", name: "เจ้าของร้าน", rights: [...OWNER_POSITION_RIGHTS] },
      { id: "002", name: "ผู้จัดการ", rights: [...MANAGER_POSITION_RIGHTS] },
      { id: "004", name: "พนักงานขาย", rights: ["100", "101", "106"] },
    ],
    receipt: {
      footer: "Thank you & See you again:)",
      footerImage: { imageId: "", status: false },
      header: RECEIPT_HEADER,
      headerImage: { imageId: "", status: false },
      price: false,
      bottomEnable: false,
      thankText: "ขอบคุณที่อุดหนุนนะคะ",
    },
    scShopId: "",
    shift: false,
    smartAddress: [],
    smartCategory: [],
    smartCoupon: [
      { id: 1, name: "ส่วนลด 10 บาท", point: 100, status: true, value: 10, imageId: COUPON_IMAGES.discountten },
      { id: 2, name: "ส่วนลด 20 บาท", point: 200, status: true, value: 20, imageId: COUPON_IMAGES.discounttweenty },
      { id: 3, name: "ส่วนลด 50 บาท", point: 500, status: true, value: 50, imageId: COUPON_IMAGES.discountfifty },
      { id: 4, name: "ส่วนลด 100 บาท", point: 1000, status: true, value: 100, imageId: COUPON_IMAGES.discounthundred },
    ],
    smartPoint: {
      rate: 20,
      point: 3,
      date: [],
      days: [{ id: 3, value: 1 }],
      memberTier: [],
      expire: { status: true, duration: "year", period: 1 },
    },
    tel: "",
    vip: [],
    soundPlayers: [
      { mainStatus: true, status: true, sound: "success2", name: "เพิ่มจำนวนสินค้า" },
      { mainStatus: true, status: true, sound: "delete6", name: "ลดจำนวนสินค้า" },
      { mainStatus: true, status: true, sound: "delete4", name: "ลบสินค้า" },
      { mainStatus: true, status: true, sound: "clean3", name: "ล้างตะกร้า" },
      { mainStatus: true, status: true, sound: "error", name: "แจ้งลืมบันทึก" },
      { mainStatus: true, status: true, sound: "save", name: "บันทึกสำเร็จ" },
      { mainStatus: true, status: true, sound: "cashier4", name: "ชำระเงินเรียบร้อย" },
      { mainStatus: true, status: true, sound: "error2", name: "สแกนไม่พบสินค้า" },
      { mainStatus: true, status: true, sound: "save3", name: "พักบิล" },
    ],
    printers: [],
    notiImport: [],
    notiShift: [],
    notiStaff: [],
    notiStock: [],
    notiSummary: [],
    notiCancelBill: [],
    notiCheckin: [],
    notiCredit: [],
    notiRequisition: [],
    soundStatus: true,
    destinationAddress: [],
    creditPoint: true,
    imageLimit: 100,
    imageMore: 0,
    smartReward: [],
    shopchampPayment: [
      { id: 1, name: "เงินสด", mortal: true, status: true },
      { id: 2, name: "พร้อมเพย์", mortal: true, status: true },
      { id: 3, name: "เงินเซ็น", mortal: true, status: false },
    ],
    tax: { name: "", tel: "", address: "", taxNumber: "", branch: "", fax: "", status: false, headquarter: true },
    taxCustomer: [],
    line: { liff: "", channelAccessToken: "", userId: "" },
    lineNoti: {},
    lineUsers: [],
    rounding: { status: false, type: "down" },
    logo: "",
    totalMember: 0,
    shopchampVat: { status: true, value: { type: "Include", amount: "7" } },
    categoryExpense: [],
    customerAds: [],
    receiptPattern: "month",
    wholesaleId: "",
  };
}

const initialPos = () => ({
  id: "",
  name: "",
  shiftId: "",
  uniqueId: "",
  printerType: "bluetooth",
  printerSize: "58",
  printerBluetooth: { android: { address: "", name: "" }, ios: { address: "", name: "" } },
  printerEthernet: "",
  printerUsb: { vendor_id: "", product_id: "", device_name: "" },
  posNumber: "",
  deviceName: "",
});

const initialShift = () => ({
  closeBy: "", closeCash: "", closeComment: "", closeDiff: "", closeTime: "", closeWithDraw: "",
  duringShift: [],
  openBy: "", openCash: "", openComment: "", openDiff: "", openTime: "", openWithDraw: "",
  shopId: "", posId: "", currentCash: 0,
  status: false,
  lastShiftDate: "20230909",
  shiftCount: 0,
  receiptNumber: "",
});

const VIP_TYPES = Object.freeze(["premium", "staff", "member", "warehouse", "delivery"]);
const initialVip = () => VIP_TYPES.map((type) => ({ type, expire: new Date(OLD_EPOCH_ISO) }));

/**
 * buildNewShop({shopDocId, shiftId, uid, profile, input, scShopId, now}) → {shop, shift, port, currentLogin}
 *   รูปเดียวกับ main3 NewShopScreen.js:66-120 ทุก field · เพิ่มอย่างเดียว: createRequestId · createdVia:'pos'
 */
function buildNewShop({ shopDocId, shiftId, uid, profile, input, scShopId, now }) {
  const p = profile && typeof profile === "object" ? profile : {};
  const str = (v) => (typeof v === "string" ? v : "");
  const shop = {
    ...staticShopPart(),
    dateTime: now,
    cutOff: new Date(OLD_EPOCH_ISO),
    name: input.name,
    tel: input.tel,
    scShopId,
    humanResource: [
      { id: uid, position: ["001"], status: "active", name: str(p.name), imageId: str(p.imageId), email: str(p.email), rights: [...INITIAL_RIGHTS] },
    ],
    smartAddress: [input.smartAddress[0], input.smartAddress[1], String(input.smartAddress[2]), String(input.smartAddress[3])],
    POSs: [{ ...initialPos(), shiftId, uniqueId: input.uniqueId, id: input.posId, deviceName: input.deviceName, name: "แคชเชียร์ 1" }],
    id: shopDocId,
    shopId: shopDocId,
    vip: initialVip(),
    notiShift: [uid],
    notiCancelBill: [uid],
    notiImport: [uid],
    notiStock: [uid],
    notiSummary: [uid],
    notiCheckin: [uid],
    notiRequisition: [uid],
    createRequestId: input.requestId,
    createdVia: "pos",
  };
  const shift = { ...initialShift(), id: shiftId, posId: input.posId, shopId: shopDocId };
  const port = { lastLogin: now, position: ["001"], shopId: shopDocId, shopName: input.name, timestamp: now };
  const currentLogin = { shopId: shopDocId, rights: [...INITIAL_RIGHTS] };
  return { shop, shift, port, currentLogin };
}

module.exports = { buildNewShop, staticShopPart, initialPos, initialShift, initialVip, OLD_EPOCH_ISO, VIP_TYPES };
