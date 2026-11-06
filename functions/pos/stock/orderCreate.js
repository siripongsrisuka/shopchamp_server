// pos/stock/orderCreate — ซื้อชุดสินค้าพร้อมขาย: ใบ `stockOrder` แนบสลิป + เลขใบจาก server + แจ้งเตือน (ก้อน 9a · DEV-0001)
//
// สัญญา: shopchamp-center/api/stock.orderCreate.yaml · คำขอ StockOrderCreateRequest
// ทางเดิม: `main3:src/screens/ImportStockPayScreen.js:96-150` submit · ทีมงานอนุมัติใน care (`ApproveStockScreen.js` · DEV-0003)
//
// ด่าน: callerAccess → schema → ไม่ต้องมีสิทธิ์พิเศษ (เดิมใครในร้านก็ซื้อได้) · คนกดต้อง active (B-11)
//   ชุด/ราคา/จำนวนต้องตรงตารางของ server (ตารางเดียวกับแอป `Modal_FastProduct.js:29-37`) ไม่ตรง = 409 pack_mismatch
// transaction: shop · stockOrder/{orderUUID} (มีแล้วของร้านนี้ = 200 duplicate ไม่เผาเลข · ร้านอื่น 409) · admin/stockNumber
//   เลขใบ = `yyyyMM` เวลาไทยของ server + ลำดับ 6 หลักจาก admin/stockNumber.value + 1 (สูตรเดิม `Utility/dateTime.js:245`)
//     doc ตัวนับไม่มี = เลข 1 และสร้าง doc (เดิมไม่สร้าง ⇒ ทุกใบได้ 000001 · stockOrder.md SB7)
// เขียน: stockOrder/{orderUUID} รูปเดิม {status:'order', imageId, shopId, shopName, profileId, profileName, timestamp, orderNumber, id, price, qty} + {orderUUID}
//   admin/stockNumber {value, timestamp} · notification รูปเดิม {heading:'ซื้อรายการสินค้า <qty> รายการ', shopId, notificationContent, categoryId:99, timestamp}
//   push ถึงทีมงาน/ผู้ซื้อ ยังอยู่ฝั่งแอป
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../firebase");
const { ok, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminTrail, adminFlag, resolveShopRef, belongsToShop } = require("../_shared/auth");
const S = require("./_shared");

// ตารางชุดที่ขายจริง (ชุด 0 1 ฟรี ไม่ผ่านทางนี้)
const PACKS = Object.freeze({ 2: { qty: 1000, price: 100 }, 3: { qty: 1500, price: 150 }, 4: { qty: 2000, price: 200 }, 5: { qty: 3000, price: 300 }, 6: { qty: 4000, price: 400 } });

function orderNumberOf(now, seq) {
  const t = new Date(now.getTime() + 7 * 3600 * 1000).toISOString();
  return t.slice(0, 4) + t.slice(5, 7) + String(seq).padStart(6, "0");
}

function orderCreate(deps) {
  return async function handler(req, res) {
    try {
      const body = S.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(S.schemaOf("StockOrderCreateRequest"), body, res);
      if (!input) return;
      const now = await readNow(deps);
      const trail = adminTrail(access);
      const orderRef = db.collection("stockOrder").doc(input.orderUUID);
      const counterRef = db.collection("admin").doc("stockNumber");
      const notiRef = db.collection("notification").doc();

      const out = await db.runTransaction(async (tx) => {
        const [shopSnap, orderSnap, counterSnap] = await Promise.all([
          tx.get(db.collection("shop").doc(access.shopId)), tx.get(orderRef), tx.get(counterRef),
        ]);
        if (!shopSnap.exists) S.refuse(404, "shop_not_found");
        const shop = shopSnap.data() || {};
        const ref = await resolveShopRef({ db, shopDocId: access.shopId, shop });
        if (orderSnap.exists) {
          const prev = orderSnap.data() || {};
          if (!belongsToShop(prev.shopId, ref)) S.refuse(409, "order_uuid_other_shop", "รหัสใบสั่งซื้อนี้เป็นของร้านอื่น");
          return { duplicate: true, orderNumber: prev.orderNumber };
        }
        const pack = PACKS[input.packId];
        if (!pack || pack.price !== input.price || pack.qty !== input.qty) {
          S.refuse(409, "pack_mismatch", "ราคาหรือจำนวนของชุดสินค้าไม่ตรง กรุณาเปิดหน้าซื้อใหม่", { pack: pack || null });
        }
        S.requireActiveStaff(shop, input.staffId, access);
        const cur = counterSnap.exists ? counterSnap.data() || {} : {};
        const prevSeq = Number.isSafeInteger(cur.value) && cur.value >= 0 ? cur.value : 0;
        const seq = prevSeq + 1;
        const orderNumber = orderNumberOf(now, seq);
        const shopField = ref.shopId || access.shopId;
        tx.set(counterRef, { value: seq, timestamp: now }, { merge: true });
        tx.set(orderRef, {
          status: "order",
          imageId: input.imageId,
          shopId: shopField,
          shopName: typeof shop.name === "string" ? shop.name : "",
          profileId: input.staffId,
          profileName: input.staffName,
          timestamp: now,
          orderNumber,
          id: input.packId,
          price: pack.price,
          qty: pack.qty,
          orderUUID: input.orderUUID,
          ...trail,
        });
        tx.set(notiRef, {
          heading: `ซื้อรายการสินค้า ${pack.qty} รายการ`,
          shopId: shopField,
          notificationContent: "สถานะ : รอตรวจสอบ\n*รอตรวจสอบยืนยันการชำระเงิน ภายใน 24 ชั่วโมง",
          categoryId: 99,
          timestamp: now,
          ...trail,
        });
        return { duplicate: false, orderNumber };
      });
      return ok(res, { orderId: input.orderUUID, ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { orderCreate, orderNumberOf, PACKS };
