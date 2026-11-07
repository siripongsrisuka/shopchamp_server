// pos/company/_orders.js — ของร่วมของใบสั่งซื้อฝั่งบริษัท 3 ชนิด (ก้อน 9d · DEV-0001)
//
// ใช้ที่: packageOrder.js · hardwareOrder.js · imageOrder.js · (ภายหลัง: ใบสั่งซื้อสินค้า stockOrder ของ 9a ใช้ตัวนับนี้ได้)
// ทุกฟังก์ชันในไฟล์นี้ไม่อ่านฐานเอง ยกเว้น runOrder ซึ่งเปิด transaction เดียวต่อคำขอ
//
// ลำดับของ runOrder (เหมือนกันทั้ง 3 ชนิด):
//   transaction อ่านครบก่อนเขียน: shop · ใบ {orderUUID} · ตัวนับ admin/<x>Number · เอกสารราคา (ถ้ามี) · profile ผู้กด
//     ร้านไม่มี 404 shop_not_found
//     ใบ {orderUUID} มีแล้ว: ร้านอื่น 409 order_uuid_other_shop · ร้านนี้แต่ยอดหรือรายการต่าง 409 order_uuid_mismatch · ตรง = 200 duplicate (ไม่ออกเลขใหม่)
//     ราคา (quote) ไม่ได้ = 409/503 ตามชนิด · expectedNet ≠ ยอดที่ server คิด (ระดับสตางค์) = 409 price_changed {net}
//     ตัวนับ: ไม่มี doc = สร้าง {value:1} (AC-38) · value เสีย = 500 counter_broken (ไม่เขียน NaN · admin B9)
//   เขียน: ตัวนับ · ใบ (doc id = orderUUID) · notification/<collection>-<orderUUID> 1 ใบ categoryId 99 (รูปเดิม)
// ทีมงาน (byAdmin) = ใบและ notification มี {byAdmin:true, adminUid} · คำตอบ 2xx มี byAdmin:true
// push (DEV-0001 push · แอปใหม่ไม่มี OneSignal): หลัง commit ครั้งที่ไม่ใช่ duplicate · orderPushes() ประกอบ 2 ข้อความ
//   ① ผู้กดซื้อ (access.uid · ทุกร้าน = pushByIdFilter เดิม) ② ทีมงานในรายชื่อ admin/<doc>.admin (ทุกร้าน)
//   รายชื่อทีมงานอ่านหลัง commit นอก transaction (doc เดียวกับที่แอปเก่าอ่าน: admin/package · admin/hardware) · อ่านไม่ได้ = ส่งแค่ผู้ซื้อ
//   แทนจุดส่งในแอป PayScreen.js:172-174 · HardwareSummaryScreen.js:146-148 · ImageLimitScreen.js:135-137 · ImportStockPayScreen.js:135-137
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { deny } = require("../_shared/respond");
const { adminTrail, resolveShopRef, belongsToShop } = require("../_shared/auth");

const COMPANY_ORDER_CATEGORY = 99; // notification §1.4 · ไม่มีแท็บ เห็นใน "ทั้งหมด"

class Refusal extends Error {
  constructor(d) { super(d.error); this.deny = d; }
}
const refuse = (d) => { throw new Refusal(d); };

const sat = (v) => logic.toSatang(v);
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const str = (v) => (typeof v === "string" ? v : "");

/**
 * runOrder({kind, access, input, now, collection, counterDoc, priceDoc, quote, buildOrder, buildNoti})
 *   collection  'packageOrder' | 'hardwareOrder' | 'imageOrder'
 *   counterDoc  'packageNumber' | 'hardwareNumber' | 'imageNumber'
 *   priceDoc    'package' | 'hardware' | null (พื้นที่รูปใช้ตารางในโค้ด)
 *   quote(priceData) → {ok:true, net, ...} | deny   (คิดราคาจากเอกสารที่อ่านใน transaction)
 *   sameOrder(prev, input) → true เมื่อรายการของใบเดิมตรงกับคำขอ (ยอดเทียบให้แล้วระดับสตางค์)
 *   buildOrder({shop, ref, shopDocId, profile, q, orderNumber}) → field ของใบ (ไม่รวม orderUUID/source/trail · ใส่ให้ที่นี่)
 *   buildNoti({shop, ref, shopDocId, q}) → {heading, notificationContent, shopId}
 * @returns {Promise<{duplicate:boolean, orderId, orderNumber, net, shopName}>} · ปัด = throw Refusal · shopName ใช้ประกอบ push (handler ตัดออกก่อนตอบ)
 */
async function runOrder(p) {
  const { access, input, now, collection, counterDoc, priceDoc, quote, sameOrder, buildOrder, buildNoti } = p;
  const shopDocId = access.shopId;
  const trail = adminTrail(access);
  const shopRef = db.collection("shop").doc(shopDocId);
  const orderRef = db.collection(collection).doc(input.orderUUID);
  const counterRef = db.collection("admin").doc(counterDoc);
  const priceRef = priceDoc ? db.collection("admin").doc(priceDoc) : null;
  const profileRef = db.collection("profile").doc(access.uid);
  // doc id คงที่ต่อใบ (เดิม auto id) ⇒ transaction ลองซ้ำหรือส่งซ้ำไม่ได้ notification ใบที่ 2 · หัว = ชนิดใบ กันชนข้ามชนิด
  const notiRef = db.collection("notification").doc(`${collection}-${input.orderUUID}`);

  return db.runTransaction(async (tx) => {
    const [shopSnap, orderSnap, counterSnap, priceSnap, profileSnap] = await Promise.all([
      tx.get(shopRef), tx.get(orderRef), tx.get(counterRef), priceRef ? tx.get(priceRef) : Promise.resolve(null), tx.get(profileRef),
    ]);
    if (!shopSnap.exists) refuse(deny(404, "shop_not_found"));
    const shop = shopSnap.data() || {};
    const ref = await resolveShopRef({ db, shopDocId, shop });

    // ส่งซ้ำ: เทียบกับคำขอ ไม่ใช่กับราคาปัจจุบัน (ราคาเปลี่ยนหลังกดครั้งแรกก็ยังได้ใบเดิม)
    if (orderSnap.exists) {
      const prev = orderSnap.data() || {};
      if (!belongsToShop(prev.shopId, ref)) refuse(deny(409, "order_uuid_other_shop", "รหัสใบสั่งซื้อนี้เป็นของร้านอื่น"));
      if (sat(prev.net) !== sat(input.expectedNet) || !sameOrder(prev, input)) {
        refuse(deny(409, "order_uuid_mismatch", "รหัสใบสั่งซื้อนี้ใช้กับรายการอื่นไปแล้ว"));
      }
      return { duplicate: true, orderId: input.orderUUID, orderNumber: str(prev.orderNumber), net: logic.roundMoney(prev.net), shopName: str(shop.name) };
    }
    const priceData = priceSnap && priceSnap.exists ? priceSnap.data() : null;
    const q = quote(priceData);
    if (!q.ok) refuse(q);
    if (sat(q.net) !== sat(input.expectedNet)) {
      refuse(deny(409, "price_changed", "ราคาเปลี่ยนแล้ว กรุณาตรวจยอดอีกครั้ง", { net: q.net }));
    }

    const counter = logic.companyOrderNumber(counterSnap.exists ? counterSnap.data() || {} : null, now);
    if (!counter.ok) refuse(deny(500, "counter_broken", "ตัวนับเลขใบสั่งซื้อเสีย กรุณาติดต่อทีมงาน"));

    const profile = profileSnap.exists && isObj(profileSnap.data()) ? profileSnap.data() : {};
    const order = {
      ...buildOrder({ shop, ref, shopDocId, profile, q, orderNumber: counter.orderNumber }),
      orderNumber: counter.orderNumber,
      orderUUID: input.orderUUID,
      source: "pos",
      ...trail,
    };
    const noti = buildNoti({ shop, ref, shopDocId, q });

    if (counter.created) tx.set(counterRef, { value: counter.value, timestamp: now });
    else tx.update(counterRef, { value: counter.value, timestamp: now });
    tx.set(orderRef, order);
    tx.set(notiRef, {
      heading: noti.heading,
      shopId: noti.shopId,
      notificationContent: noti.notificationContent,
      categoryId: COMPANY_ORDER_CATEGORY,
      timestamp: now,
      ...trail,
    });
    return { duplicate: false, orderId: input.orderUUID, orderNumber: counter.orderNumber, net: q.net, shopName: str(shop.name) };
  });
}

/** ร้านที่ใส่ใน notification: field shop.shopId ที่พิสูจน์แล้ว ไม่งั้น doc id (จอประวัติ query ด้วย field · notification.md §1.3) */
const notiShopIdOf = (ref, shopDocId) => ref.shopId || shopDocId;

/** ผู้กดซื้อ: ชื่อ/เบอร์จาก profile · ไม่มี = '' (เดิมเว็บเขียน undefined แล้วใบไม่เกิด · PO-05 PO-16) */
const buyerOf = (access, profile) => ({ profileId: access.uid, profileName: str(profile.name), tel: str(profile.tel) });

/**
 * orderPushes({access, adminDoc, buyer, staff}) → [ข้อความผู้ซื้อ, ข้อความทีมงาน] (รูป notify)
 *   buyer/staff = {heading, content, data?} · ทีมงาน = admin/<adminDoc>.admin (array ของ uid) · ตัดผู้ซื้อออกจากรายชื่อทีมงาน (กันคนเดียวได้ 2 ข้อความ)
 *   🔒 ไม่ throw · อ่านรายชื่อพัง = คืนแค่ข้อความผู้ซื้อ
 */
async function orderPushes({ access, adminDoc, buyer, staff }) {
  const out = [{ to: { kind: "people", ids: [access.uid] }, ...buyer }];
  try {
    const snap = await db.collection("admin").doc(adminDoc).get();
    const list = snap && snap.exists && isObj(snap.data()) && Array.isArray(snap.data().admin) ? snap.data().admin : [];
    const ids = [...new Set(list.filter((x) => typeof x === "string" && x !== "" && x !== access.uid))];
    if (ids.length) out.push({ to: { kind: "people", ids }, ...staff });
  } catch (e) {
    console.warn(`push company admin list ${adminDoc} ${(e && e.message) || e}`);
  }
  return out;
}

const PENDING_PUSH_TEXT = "รอตรวจสอบยืนยันการชำระเงิน ภายใน 24 ชั่วโมง";

module.exports = { runOrder, Refusal, refuse, notiShopIdOf, buyerOf, orderPushes, PENDING_PUSH_TEXT, COMPANY_ORDER_CATEGORY, sat, str };
