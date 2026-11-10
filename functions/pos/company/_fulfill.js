// pos/company/_fulfill.js — "ตัวเปิดของตัวเดียว" ของใบสั่งซื้อบริษัท 4 ชนิด (DEV-0003 U1 · แบบ lanes/dev/source/office-autopay-design.md §หลักข้อ 1)
//
// ใครเรียก: ทางชำระอัตโนมัติ (posxpay ยืนยัน · U2 payStatus · U3 cron) และทางกดมือใน office (U4) เรียก fulfill() ตัวเดียวกัน
// ย้ายตรรกะ "อนุมัติ" จาก care (เขียนฐานจากเบราว์เซอร์) มาไว้ที่นี่ · พฤติกรรมต่อชนิดต้องตรง care ตัวต่อตัว (cite บรรทัดไว้ที่แต่ละชนิด)
// ยังไม่มี route/สัญญา (U2/U4 ค่อยต่อ) · ไฟล์นี้ไม่ตอบ HTTP · ปัด = throw Refusal (ตัวเดียวกับ _orders.js) ก่อนเขียนตัวแรกเสมอ
//
// สัญญา: fulfill({kind, orderUUID, via, actor, payment, now}) → Promise<FulfillResult>
//   kind     'package' | 'hardware' | 'image' | 'stock'
//   via      'auto' (posxpay ยืนยันแล้ว · ต้องส่ง payment) | 'manual' (ทีมงานกดใน office)
//   actor    {uid, name} = คนอนุมัติ → ลง approveId/approveName แบบ care · via auto ไม่ส่ง = AUTO_ACTOR
//   payment  (เมื่อ auto) {provider:'posxpay', providerRef, paidSatang} · paidSatang ต้องเท่ายอดของใบ (toSatang) เป๊ะ ไม่งั้น 409 amount_mismatch
//   now      Date ของ server (ผู้เรียกอ่าน readNow(deps) ครั้งเดียว · ไฟล์นี้ไม่อ่าน new Date() เอง)
//
// ลำดับ (transaction เดียว · อ่านครบก่อนเขียน):
//   อ่านใบ → ไม่มี 404 order_not_found · status 'cancel' 409 order_cancelled · เปิดแล้ว (ตาราง KINDS.opened) = คืน {duplicate:true} ไม่เขียนอะไร
//     · status อื่นที่ไม่รู้จัก 409 order_status_unexpected (fail-closed · ไม่เดาว่ายังรออยู่)
//   via auto → ยอดของใบ (net · ใบชุดสินค้าใช้ price) อ่านเป็นสตางค์ไม่ได้ 409 order_amount_invalid · ≠ paidSatang 409 amount_mismatch
//   อ่านร้าน (ตาม KINDS.shopLookup) + admin/package (เฉพาะแพ็กเกจ) → คิด → เขียนใบ + ร้าน
//   ใบทุกชนิดได้ trail: approveId approveName (care) + paidVia + fulfilledAt + payment (เมื่อ auto)
//
// ผลต่อชนิด (ตรง care · ดูตารางที่หัวแต่ละฟังก์ชัน):
//   package  shop.vip[] ต่ออายุ (logic.companyVipRenewal) · currentPackage += ids · IsVip:true · lossVip:false · ใบ status:'success'
//            gateway id 11/12 เปิดได้ (type/วันมาจาก admin/package ไม่ใช่ตาราง 1-10 ของ care · census ช่องว่าง 3)
//   hardware ใบ status:'checked' = "จ่ายแล้ว" (Pack เคาะ 2026-11-10 ข้อ 2) · ❌ ไม่ไป sending/success (การส่งของยังกดมือ HardwareHandleScreen)
//   image    shop.imageMore += qty · ใบ status:'success'
//   stock    ใบ status:'paid' (จองใบใน tx) แล้วคัดสินค้าจาก masterSectionStock ลง stock ของร้าน **นอก transaction** (หลายร้อย-พันแถว · เกินเพดาน tx)
//            ผล import บันทึกบนใบ stockImport {status:'pending'|'done'|'failed', ...} · import พัง = ใบยัง paid (เงินเข้าแล้ว) ให้ U4 สั่งทำซ้ำ ไม่ throw
//
// กันซ้ำ/กันวิ่งซ้อน: อ่านสถานะสดใน transaction · 2 ตัวเรียกพร้อมกัน = ตัวหนึ่ง commit อีกตัว retry แล้วเห็น opened → duplicate
// push: ไม่ส่งเอง · คืน `push` (รูป notify ของ _shared/push/notify.js) ให้ผู้เรียกส่งหลังตอบ · ข้อความเท่า care
// ❌ ไม่ require SDK ตัวจริง · db จาก ../../firebase (เทส/harness แทนของปลอม) · ❌ ไม่แตะ route · ❌ ไม่ import ของบ้านอื่น
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { deny } = require("../_shared/respond");
const { serverTime } = require("../_shared/stockJournal");
const { Refusal, refuse, sat, str } = require("./_orders");

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const isNonEmptyString = (v) => typeof v === "string" && v !== "";
const validDocId = (v) => isNonEmptyString(v) && v.length <= 1500 && !v.includes("/") && v !== "." && v !== "..";

/** ผู้อนุมัติเมื่อทางอัตโนมัติไม่ส่ง actor (ไม่มีคนกด · approveId ต้องมีค่าให้จอประวัติของ care/office อ่านได้) */
const AUTO_ACTOR = Object.freeze({ uid: "system:posxpay", name: "ชำระเงินอัตโนมัติ (posxpay)" });
const PROVIDERS = Object.freeze(["posxpay"]);

/**
 * ตารางต่อชนิด
 *   collection   ชื่อ collection ของใบ
 *   amountField  ช่องยอดที่ต้องเท่ายอดจ่าย (ใบ 3 ชนิดใช้ net · ใบชุดสินค้าเขียน price ไม่มี net · stock/orderCreate.js)
 *   opened       สถานะที่แปลว่า "เปิดของแล้ว" → duplicate (hardware รวม sending/success ที่ HardwareHandleScreen เลื่อนต่อจาก checked)
 *   done         สถานะที่ fulfill เขียน
 *   shopLookup   'doc' = หา shop ด้วย doc id ก่อน (care แพ็กเกจ `.doc(shopId)` ApproveSoftwareScreen.js:70)
 *                'field' = หาด้วย where shopId == ก่อน (care รูป/ชุดสินค้า ApproveImageScreen.js:47 · ApproveStockScreen.js:51) · null = ไม่แตะร้าน
 */
const KINDS = Object.freeze({
  package: { collection: "packageOrder", amountField: "net", opened: ["success"], done: "success", shopLookup: "doc" },
  hardware: { collection: "hardwareOrder", amountField: "net", opened: ["checked", "sending", "success"], done: "checked", shopLookup: null },
  image: { collection: "imageOrder", amountField: "net", opened: ["success"], done: "success", shopLookup: "field" },
  stock: { collection: "stockOrder", amountField: "price", opened: ["paid"], done: "paid", shopLookup: "field" },
});
const VIAS = Object.freeze(["auto", "manual"]);

// ── ตรวจรูปคำขอ (ก่อนแตะฐาน) ────────────────────────────────────────────────────────────────────────
function normalizeInput(p) {
  const bad = (m) => refuse(deny(400, "invalid_request", m));
  if (!isObj(p)) bad("ต้องส่ง {kind, orderUUID, via, ...}");
  const { kind, orderUUID, via, actor, payment, now } = p;
  if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) bad("kind ต้องเป็น package | hardware | image | stock");
  if (!validDocId(orderUUID)) bad("orderUUID ต้องเป็นข้อความที่ใช้เป็น doc id ได้");
  if (!VIAS.includes(via)) bad("via ต้องเป็น auto | manual");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) bad("now ต้องเป็น Date ที่ใช้ได้");
  let who = actor;
  if (who === undefined || who === null) {
    if (via !== "auto") bad("via manual ต้องส่ง actor {uid, name}");
    who = AUTO_ACTOR;
  }
  if (!isObj(who) || !isNonEmptyString(who.uid) || typeof who.name !== "string") bad("actor ต้องเป็น {uid: ข้อความ, name: ข้อความ}");
  let pay = null;
  if (via === "auto") {
    if (!isObj(payment)) bad("via auto ต้องส่ง payment {provider, providerRef, paidSatang}");
    if (!PROVIDERS.includes(payment.provider)) bad("payment.provider ต้องเป็น posxpay");
    if (!isNonEmptyString(payment.providerRef)) bad("payment.providerRef ต้องเป็นข้อความ");
    if (!Number.isSafeInteger(payment.paidSatang) || payment.paidSatang <= 0) bad("payment.paidSatang ต้องเป็นจำนวนเต็มสตางค์ > 0");
    pay = { provider: payment.provider, providerRef: payment.providerRef, paidSatang: payment.paidSatang };
  } else if (payment !== undefined && payment !== null) {
    bad("via manual ไม่รับ payment (สลิป/โอนมือ ไม่มี providerRef)");
  }
  return { kind, spec: KINDS[kind], orderUUID, via, actor: { uid: who.uid, name: who.name }, payment: pay, now: new Date(now.getTime()) };
}

/** trail ที่ลงบนใบทุกชนิด: approveId/approveName แบบ care + ทางที่จ่าย + เวลา + หลักฐานจ่าย (auto) */
function trailOf({ actor, via, payment, now }) {
  return {
    approveId: actor.uid,
    approveName: actor.name,
    paidVia: via,
    fulfilledAt: now,
    ...(payment ? { payment } : {}),
  };
}

// ── หาร้านใน transaction ─────────────────────────────────────────────────────────────────────────────
/**
 * อ่าน shop/{shopId} และ shop where shopId == shopId (limit 2) พร้อมกันใน tx แล้วเลือกตาม lookup
 *   'doc'   doc มี = ใช้ doc (care แพ็กเกจ) · ไม่มี = ผลค้น 1 ร้านพอดี
 *   'field' ผลค้น 1 ร้านพอดี = ใช้ (care รูป/ชุดสินค้า) · ไม่พอดี = doc ถ้ามี
 *   ไม่ได้สักทาง: ค้นได้ ≥2 → 409 shop_ambiguous · ไม่งั้น 404 shop_not_found (care รูป: ไม่เจอ = ไม่เพิ่มโควตาแต่ push ว่าเรียบร้อย · ช่องว่าง 6 ⇒ ที่นี่ปัด)
 */
async function readShop(tx, shopId, lookup) {
  if (!validDocId(shopId)) refuse(deny(409, "order_shop_invalid", "ใบนี้ไม่มีรหัสร้านที่ใช้ได้"));
  const shops = db.collection("shop");
  const [docSnap, holders] = await Promise.all([tx.get(shops.doc(shopId)), tx.get(shops.where("shopId", "==", shopId).limit(2))]);
  const hits = holders && Array.isArray(holders.docs) ? holders.docs : [];
  const fromDoc = docSnap && docSnap.exists ? { ref: shops.doc(docSnap.id), id: docSnap.id, data: docSnap.data() || {} } : null;
  const fromField = hits.length === 1 ? { ref: shops.doc(hits[0].id), id: hits[0].id, data: hits[0].data() || {} } : null;
  const pick = lookup === "doc" ? fromDoc || fromField : fromField || fromDoc;
  if (pick) return pick;
  if (hits.length >= 2) refuse(deny(409, "shop_ambiguous", "รหัสร้านของใบนี้ตรงกับร้านมากกว่า 1 ร้าน", { shopId }));
  refuse(deny(404, "shop_not_found", "ไม่พบร้านของใบนี้", { shopId }));
  return null;
}

// ── ผลต่อชนิด (คืน {writes: fn(tx), effects, push, after?}) ─────────────────────────────────────────

/**
 * แพ็กเกจ = care `ApproveSoftwareScreen.js:67-110`
 *   :70-74  อ่าน shop.doc(shopId) → {vip=[], currentPackage=[]}
 *   :75-98  ต่ออายุต่อชนิด (สูตรอยู่ที่ logic.companyVipRenewal · เทียบวันปฏิทินไทย · 30/365 วัน)
 *   :99-104 shop.update {vip, currentPackage:[...เดิม, ...ids], IsVip:true, lossVip:false}
 *   :105-109 ใบ.update {status:'success', approveId, approveName}
 *   :112    push ผู้ซื้อ heading 'อนุมัติ แพ็กเกจ เรียบร้อยค่ะ!' content 'กรุณากดอัปเดต ข้อมูล 1 ครั้งค่ะ'
 *   type/วัน: care ใช้ packageMaps 1-10 (`:18-29` · ใบ gateway 11/12 ได้ undefined แล้ว throw ที่ :77) ⇒ ที่นี่อ่าน admin/package.value[].type + price[].day
 */
async function planPackage(tx, { order, spec, now, trail }) {
  const [shop, pkgSnap] = await Promise.all([readShop(tx, order.shopId, spec.shopLookup), tx.get(db.collection("admin").doc("package"))]);
  const pkgDoc = pkgSnap && pkgSnap.exists ? pkgSnap.data() : null;
  const items = logic.companyPackageFulfillItems(pkgDoc, order.packageId);
  if (!items.ok) {
    if (items.error === "PACKAGE_DOC_INVALID") refuse(deny(503, "package_config_unavailable", "อ่านแคตตาล็อกแพ็กเกจไม่ได้ กรุณาติดต่อทีมงาน"));
    if (items.error === "NO_PACKAGE") refuse(deny(409, "order_packages_empty", "ใบนี้ไม่มีรายการแพ็กเกจ"));
    refuse(deny(409, "package_unresolvable", "แพ็กเกจในใบนี้หาชนิดหรือรอบบิลไม่ได้ กรุณาติดต่อทีมงาน", { packageId: String(items.id), reason: items.error }));
  }
  const renew = logic.companyVipRenewal(shop.data.vip, items.items, now);
  if (!renew.ok) refuse(deny(500, "vip_renewal_failed", "คำนวณวันหมดอายุไม่ได้", { reason: renew.error }));
  const current = Array.isArray(shop.data.currentPackage) ? shop.data.currentPackage : [];
  const shopPatch = { vip: renew.vip, currentPackage: [...current, ...renew.ids], IsVip: true, lossVip: false };
  const expires = {};
  for (const r of renew.vip) if (renew.touched.includes(r.type)) expires[r.type] = r.expire;
  return {
    shopDocId: shop.id,
    writes: (t, orderRef) => {
      t.update(shop.ref, shopPatch);
      t.update(orderRef, { status: spec.done, ...trail });
    },
    effects: { vip: renew.vip, expires, packageIds: renew.ids, items: items.items },
    push: { to: { kind: "people", ids: [str(order.profileId)] }, heading: "อนุมัติ แพ็กเกจ เรียบร้อยค่ะ!", content: "กรุณากดอัปเดต ข้อมูล 1 ครั้งค่ะ" },
  };
}

/**
 * อุปกรณ์ = care `ApproveHardwareScreen.js:41-49` (ขั้น "ยืนยันการชำระเงิน")
 *   :44-48 ใบ.update {status:'checked', approveId, approveName} · :49 push 'ยืนยันการชำระเงินเสร็จสิ้น!' / 'กำลังจัดเตรียมสินค้า'
 *   ขั้นถัดไป checked → sending → success + tracking/provider อยู่ที่ `HardwareHandleScreen.js:72-88` (ทีมงานกดมือ · ไม่อยู่ในไฟล์นี้)
 *   ไม่แตะร้าน ไม่ให้สิทธิ์อะไร (census แถว 2)
 */
async function planHardware(_tx, { order, spec, trail }) {
  return {
    shopDocId: null,
    writes: (t, orderRef) => t.update(orderRef, { status: spec.done, ...trail }),
    effects: { shipping: "manual" },
    push: { to: { kind: "people", ids: [str(order.profileId)] }, heading: "ยืนยันการชำระเงินเสร็จสิ้น!", content: "กำลังจัดเตรียมสินค้า" },
  };
}

/**
 * พื้นที่รูป = care `ApproveImageScreen.js:43-59`
 *   :47-48 หาร้านด้วย where('shopId','==',shopId) (ที่นี่ readShop 'field' · ไม่เจอ = ปัด ไม่ใช่ push ว่าเรียบร้อย · ช่องว่าง 6)
 *   :54-55 shop.update {imageMore: (imageMore||0) + Number(qty)} · :56 ใบ.update {status:'success', approveId, approveName}
 *   :59    push heading `เพิ่มพื้นที่เก็บไฟล์ ${qty} รูปภาพเรียบร้อย` content 'กรุณากดอัปเดตข้อมูล 1 ครั้งค่ะ'
 *   imageMore เดิมที่ไม่ใช่ตัวเลข = 0 (care จะได้ข้อความต่อกัน "1001000") · qty ต้องเป็นจำนวนเต็ม > 0 ไม่งั้น 409
 */
async function planImage(tx, { order, spec, trail }) {
  const qty = Number(order.qty);
  if (!Number.isSafeInteger(qty) || qty <= 0) refuse(deny(409, "order_qty_invalid", "ใบนี้ไม่มีจำนวนรูปที่ใช้ได้", { qty: order.qty }));
  const shop = await readShop(tx, order.shopId, spec.shopLookup);
  const before = typeof shop.data.imageMore === "number" && Number.isFinite(shop.data.imageMore) ? shop.data.imageMore : 0;
  const imageMore = before + qty;
  return {
    shopDocId: shop.id,
    writes: (t, orderRef) => {
      t.update(shop.ref, { imageMore });
      t.update(orderRef, { status: spec.done, ...trail });
    },
    effects: { imageMore, added: qty },
    push: { to: { kind: "people", ids: [str(order.profileId)] }, heading: `เพิ่มพื้นที่เก็บไฟล์ ${qty} รูปภาพเรียบร้อย`, content: "กรุณากดอัปเดตข้อมูล 1 ครั้งค่ะ" },
  };
}

// ── ชุดสินค้าพร้อมขาย ───────────────────────────────────────────────────────────────────────────────
// care `ApproveStockScreen.js:45-73`: หาร้าน where shopId == (:51) → POST /sharedData/test {shopId, id, docId} (:53-65) → 200 แล้วใบ status:'paid' (:73)
// ตัว import = server เดิม `apis/sharedData.js:701-807` (สำเนาเดียวกันใน shopchamp_server/functions/apis/sharedData.js · ยังไม่มีตัวใหม่ใน pos/) ⇒ คัดมาที่นี่:
//   :706-716 typeMap ชุด → type ของ masterSectionStock · :719-750 รวมหมวดระดับ 1 (17 หมวด AX001-AX017) เข้า shop.smartCategory
//   :730-735 บาร์โค้ดที่ร้านมีแล้ว (ข้าม · :763) · :756-779 สินค้า = initialProduct (:269-306) + {shopId, category, cost, imageId, name, price, unit, barcode, stock:0, cashierShow}
//   :781-798 batch 500 ต่อก้อน · updateTime = serverTimestamp (DEV-0007: เวลา commit · เครื่องซิงก์ด้วย updateTime)
// ที่ต่างจากเดิม (ตั้งใจ):
//   · ลำดับ: จองใบเป็น paid ใน tx ก่อน import (เดิม import ก่อนแล้วค่อย paid · กดซ้ำ/วิ่งซ้อน = สินค้าซ้ำ · stockOrder.md SB3) · ผล import อยู่บนใบ
//   · ชุดที่ไม่รู้จัก = import failed 'pack_unknown' (เดิม `|| ['10']` แอบให้ชุดฟรี 10 รายการ)
//   · บาร์โค้ดที่มีแล้วค้นด้วย shopId ค่าเดียวกับที่เขียนลงสินค้า (เดิมค้นด้วย doc id แต่เขียน field ⇒ ร้าน S5 ซ้ำได้ · SB3)
//   · promotion.startDate/endDate = now (เดิม new Date() ตอนโหลดโมดูล = เวลาสุ่มของ instance)
const STOCK_PACK_TYPES = Object.freeze({
  0: ["10"], 1: ["500"], 2: ["1000"], 3: ["1500", "1501"], 4: ["2000", "2001"], 5: ["3000", "3001", "3002"], 6: ["4000", "4001", "4002", "4003"],
});
const STOCK_TEMPLATE_CATEGORIES = Object.freeze([
  ["AX001", "เครื่องดื่ม"], ["AX002", "อาหารแห้ง"], ["AX003", "อาหารสด"], ["AX004", "ยาสามัญประจำบ้าน"], ["AX005", "แอลกอฮอร์และบุหรี่"],
  ["AX006", "ขนมและลูกอม"], ["AX007", "นมและโยเกิร์ต"], ["AX008", "ของใช้ในครัวเรือน"], ["AX009", "ไอศครีม"], ["AX010", "ไอทีและมือถือ"],
  ["AX011", "สินค้าเกษตร"], ["AX012", "สัตว์เลี้ยง"], ["AX013", "ไฟฟ้าและประปา"], ["AX014", "เครื่องเขียน"], ["AX015", "สุขภาพและความงาม"],
  ["AX016", "ครัวและเครื่องปรุงรส"], ["AX017", "อื่นๆ"],
].map(([id, name]) => Object.freeze({ aboveId: [], level: 1, id, name })));
const STOCK_BATCH = 500;

/** initialProduct ของ server เดิม `apis/sharedData.js:269-306` ตามตัว (updateTime ถูกทับด้วย serverTimestamp ตอนเขียน) */
function stockTemplateDefaults(now) {
  return {
    barcode: "", barcodeStatus: true, cashierShow: false, category: [], consignment: false, cost: "", delivery: false, imageId: "", name: "", price: "",
    promotion: { status: false, qty: "", price: "", startDate: now, endDate: now },
    rent: false, safetyStock: { status: false, qty: "" }, shopId: "", sku: "", stock: "", unit: "ชิ้น", vatExemption: false, expReport: [],
    priceLevelStatus: false, priceLevel: [], pointStatus: true, stockCountStatus: true, customQtyStatus: false, customPriceStatus: false, other: [], selfImage: false,
  };
}

/** smartCategory ใหม่ = รวม 17 หมวดระดับ 1 เข้าของเดิม (sharedData.js:736-748) */
function mergeTemplateCategories(smartCategory) {
  const list = Array.isArray(smartCategory) ? smartCategory : [];
  const first = list.find((a) => isObj(a) && a.level === 1);
  const firstLevel = first && Array.isArray(first.value) ? first.value : [];
  if (firstLevel.length > 0) {
    const have = new Set(firstLevel.filter(isObj).map((a) => a.id));
    const merged = [...firstLevel, ...STOCK_TEMPLATE_CATEGORIES.filter((a) => !have.has(a.id)).map((a) => ({ ...a, aboveId: [] }))];
    return list.map((item) => (isObj(item) && item.level === 1 ? { level: 1, value: merged } : item));
  }
  return [{ level: 1, value: STOCK_TEMPLATE_CATEGORIES.map((a) => ({ ...a, aboveId: [] })) }];
}

/**
 * importStockTemplate({shopDocId, shopField, packId, now}) → {imported, skipped}
 *   นอก transaction · เรียกหลังใบเป็น paid แล้ว · throw เมื่อชุดไม่รู้จักหรืออ่าน/เขียนฐานล้ม (ผู้เรียกบันทึก failed บนใบ)
 */
async function importStockTemplate({ shopDocId, shopField, packId, now }) {
  const types = Object.prototype.hasOwnProperty.call(STOCK_PACK_TYPES, packId) ? STOCK_PACK_TYPES[packId] : null;
  if (!types) {
    const e = new Error("pack_unknown"); e.code = "pack_unknown"; throw e;
  }
  const shopRef = db.collection("shop").doc(shopDocId);
  const [shopSnap, ownStock, sections] = await Promise.all([
    shopRef.get(),
    db.collection("stock").where("shopId", "==", shopField).select("barcode").get(),
    db.collection("masterSectionStock").where("type", "in", types).get(),
  ]);
  const shop = shopSnap && shopSnap.exists ? shopSnap.data() || {} : {};
  const have = new Set((ownStock && Array.isArray(ownStock.docs) ? ownStock.docs : []).map((d) => (typeof d.get === "function" ? d.get("barcode") : d.data().barcode)));
  await shopRef.update({ smartCategory: mergeTemplateCategories(shop.smartCategory) });

  const defaults = stockTemplateDefaults(now);
  const cashierShow = packId === 0; // sharedData.js:753 · ชุดที่ขายผ่านใบ (2-6) = false เสมอ
  const products = [];
  let skipped = 0;
  for (const d of (sections && Array.isArray(sections.docs) ? sections.docs : [])) {
    const rows = d.data() && Array.isArray(d.data().products) ? d.data().products : [];
    for (const p of rows) {
      if (!isObj(p)) continue;
      if (have.has(p.barcode)) { skipped++; continue; }
      products.push({
        ...defaults, shopId: shopField, category: p.category, cost: Number(p.cost), imageId: p.imageId, name: p.name, price: Number(p.price), unit: p.unit,
        barcode: p.barcode, stock: 0, cashierShow,
      });
    }
  }
  const stock = db.collection("stock");
  const commits = [];
  for (let i = 0; i < products.length; i += STOCK_BATCH) {
    const batch = db.batch();
    for (const product of products.slice(i, i + STOCK_BATCH)) batch.set(stock.doc(), { ...product, updateTime: serverTime() });
    commits.push(batch.commit());
  }
  await Promise.all(commits);
  return { imported: products.length, skipped };
}

/**
 * ชุดสินค้า: ใน tx = หาร้าน (field) + ใบ status:'paid' + stockImport pending · หลัง commit = importStockTemplate แล้วบันทึกผลบนใบ
 *   push ตามของเดิม sharedData.js:801-805 (ถึงร้าน · heading 'อัปเดตรายการสินค้า') · ส่งเฉพาะ import สำเร็จ
 */
async function planStock(tx, { order, spec, now, trail }) {
  const shop = await readShop(tx, order.shopId, spec.shopLookup);
  const packId = order.id;
  return {
    shopDocId: shop.id,
    writes: (t, orderRef) => t.update(orderRef, { status: spec.done, ...trail, stockImport: { status: "pending", startedAt: now, packId: packId === undefined ? null : packId } }),
    effects: { packId: packId === undefined ? null : packId, qty: order.qty },
    push: null,
    after: async (orderRef, result) => {
      try {
        const r = await importStockTemplate({ shopDocId: shop.id, shopField: str(order.shopId), packId, now });
        await orderRef.update({ stockImport: { status: "done", startedAt: now, finishedAt: now, packId: packId === undefined ? null : packId, imported: r.imported, skipped: r.skipped } });
        result.effects.stockImport = { status: "done", imported: r.imported, skipped: r.skipped };
        result.push = { to: { kind: "shop", shopId: str(order.shopId) }, heading: "อัปเดตรายการสินค้า", content: `เพิ่มสินค้า ${r.imported} รายการเสร็จสิ้นแล้วค่ะ` };
      } catch (e) {
        const error = (e && (e.code || e.message)) || "unknown";
        console.error(`fulfill stock import ${orderRef.id} ${error}`);
        try {
          await orderRef.update({ stockImport: { status: "failed", startedAt: now, finishedAt: now, packId: packId === undefined ? null : packId, error: String(error) } });
        } catch (e2) {
          console.error(`fulfill stock import mark failed ${orderRef.id} ${(e2 && e2.message) || e2}`);
        }
        result.effects.stockImport = { status: "failed", error: String(error) };
      }
    },
  };
}

const PLANNERS = Object.freeze({ package: planPackage, hardware: planHardware, image: planImage, stock: planStock });

// ── ตัวเปิดของ ─────────────────────────────────────────────────────────────────────────────────────
/**
 * fulfill(p) → {ok:true, duplicate:true, kind, orderUUID, status}
 *            | {ok:true, duplicate:false, kind, orderUUID, status, shopDocId, amountSatang, paidVia, effects, push}
 *   ปัด = throw Refusal (e.deny = {status, error, message?, extra?}) · ไม่มีการเขียนเกิดขึ้นเมื่อปัด
 */
async function fulfill(p) {
  const input = normalizeInput(p);
  const { kind, spec, orderUUID, via, payment, now } = input;
  const trail = trailOf(input);
  const orderRef = db.collection(spec.collection).doc(orderUUID);

  const out = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap || !snap.exists) refuse(deny(404, "order_not_found", "ไม่พบใบสั่งซื้อ", { kind, orderUUID }));
    const order = snap.data() || {};
    const status = str(order.status);
    if (status === "cancel") refuse(deny(409, "order_cancelled", "ใบนี้ถูกยกเลิกแล้ว", { kind, orderUUID }));
    if (spec.opened.includes(status)) return { ok: true, duplicate: true, kind, orderUUID, status };
    if (status !== "order") refuse(deny(409, "order_status_unexpected", "สถานะใบนี้ไม่ใช่รอตรวจสอบ", { kind, orderUUID, status }));

    const amountSatang = sat(order[spec.amountField]);
    if (via === "auto") {
      if (!Number.isSafeInteger(amountSatang) || amountSatang <= 0) refuse(deny(409, "order_amount_invalid", "ยอดของใบนี้อ่านไม่ได้", { kind, orderUUID }));
      if (payment.paidSatang !== amountSatang) {
        refuse(deny(409, "amount_mismatch", "ยอดที่จ่ายไม่เท่ายอดของใบ", { kind, orderUUID, expectedSatang: amountSatang, paidSatang: payment.paidSatang }));
      }
    }

    const plan = await PLANNERS[kind](tx, { order, spec, now, trail });
    plan.writes(tx, orderRef); // เขียนตัวแรกหลังอ่านครบและไม่มีทางปัดแล้ว
    return {
      ok: true, duplicate: false, kind, orderUUID, status: spec.done, shopDocId: plan.shopDocId,
      amountSatang: Number.isSafeInteger(amountSatang) ? amountSatang : null, paidVia: via, effects: plan.effects, push: plan.push,
      __after: plan.after || null,
    };
  });

  const { __after, ...result } = out;
  if (__after) await __after(orderRef, result);
  return result;
}

module.exports = {
  fulfill, Refusal, KINDS, AUTO_ACTOR,
  // ส่วนที่เทสเจาะได้
  importStockTemplate, mergeTemplateCategories, stockTemplateDefaults, STOCK_PACK_TYPES, STOCK_TEMPLATE_CATEGORIES,
};
