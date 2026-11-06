// scenarios.mjs — สิ่งที่ client รุ่นเดิมทำจริง ทีละรูปแบบ (DEV-0001 ก้อน 6)
//
// แต่ละตัว = รูปเอกสาร + ชนิดคำสั่ง (get/list/listen/set/update/delete/transaction/batch) ตามบรรทัดต้นทางใน sites.mjs
// ตัวที่รับ `shop` รันซ้ำทั้งร้านปกติ (A) และร้านรุ่นเก่า S5 (L) ด้วยบัญชีพนักงาน (คนที่ยากสุด ไม่ใช่เจ้าของ)
import {
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, query, where, orderBy, limit,
  runTransaction, writeBatch, serverTimestamp, Timestamp, onSnapshot,
} from "firebase/firestore";
import { U, FR, FR_EMPTY, initialRights } from "./fixtures.mjs";

const k = (shop) => (shop.docId.startsWith("shopA") ? "A" : shop.docId.startsWith("legacy") ? "L" : "B");
const now = () => new Date();
// onSnapshot ครั้งแรก = ผ่านหรือถูกปัด (realtime ของจอ)
export const listenOnce = (ref) => new Promise((resolve, reject) => {
  const un = onSnapshot(ref, (s) => { un(); resolve(s); }, (e) => reject(e));
});

// ---------------- ขาย (main3:src/screens/CheckoutScreen.js:548-700 · src/Utility/function.js:185-312) ----------------
async function saleTx(db, shop, { items = 30, counter = "billId", withGuard = true, withMember = true } = {}) {
  const K = k(shop);
  const guardRef = doc(db, "receiptGuard", `uuid-${K}-${Math.random().toString(36).slice(2)}`);
  await runTransaction(db, async (t) => {
    if (withGuard) { const g = await t.get(guardRef); if (g.exists()) throw new Error("dup"); }
    const newBillRef = doc(collection(db, "bill"));
    const billIdRef = doc(db, counter, shop.docId);
    const memberRef = withMember ? doc(db, "member", `member${K}1`) : null;
    const stockRefs = Array.from({ length: items }, (_, i) => doc(db, "stock", `stock${K}${(i % 40) + 1}`));
    const uniq = [...new Map(stockRefs.map((r) => [r.path, r])).values()];
    const stockDocs = await Promise.all(uniq.map((r) => t.get(r)));
    const billIdDoc = await t.get(billIdRef);
    const memberDoc = memberRef ? await t.get(memberRef) : null;
    if (!billIdDoc.exists()) t.set(billIdRef, { month: 11, receipts: 1 }); else t.update(billIdRef, { receipts: billIdDoc.data().receipts + 1 });
    uniq.forEach((r, i) => t.update(r, { stock: stockDocs[i].data().stock - 1, updateTime: serverTimestamp(), latestSaleDate: serverTimestamp() }));
    if (memberRef) t.update(memberRef, { point: memberDoc.data().point + 1, bought: [], creditArray: memberDoc.data().creditArray });
    t.set(newBillRef, {
      shopId: shop.shopId, franchiseId: K === "A" ? FR : "", id: shop.docId, receiptNumber: "R2611-0011", dateTime: now(), billDate: "20261106",
      product: [{ id: `stock${K}1`, qty: 1 }], net: 10, member: withMember ? { id: `member${K}1` } : {}, cashierId: shop.staff, cashierName: "พนักงาน",
      shiftId: shop.docId + "-shift", posId: "pos-1", receiptUUID: guardRef.id, status: true,
    });
    if (withGuard) t.set(guardRef, { createdAt: now(), usedBy: newBillRef.id });
  });
}

export const SHOP_SCENARIOS = {
  // ----- ขาย ยกเลิก ใบกำกับ -----
  "sale-tx-month": (db, shop) => saleTx(db, shop, { items: 30, counter: "billId" }),
  "sale-tx-day": (db, shop) => saleTx(db, shop, { items: 5, counter: "billDayId", withMember: false }),
  "sale-tx-120-items": (db, shop) => saleTx(db, shop, { items: 40 }),
  "sale-copy-no-guard": (db, shop) => saleTx(db, shop, { items: 3, withGuard: false }),
  "bill-get": (db, shop) => getDoc(doc(db, "bill", `bill${k(shop)}1`)),
  "bill-update": (db, shop) => updateDoc(doc(db, "bill", `bill${k(shop)}1`), { printCount: 2 }),
  "bill-list-by-member": (db, shop) => getDocs(query(collection(db, "bill"), where("member.id", "==", `member${k(shop)}1`), orderBy("dateTime", "desc"), limit(100))),
  "bill-void-tx": async (db, shop) => {
    const K = k(shop);
    await runTransaction(db, async (t) => {
      const billRef = doc(db, "bill", `bill${K}1`); const memberRef = doc(db, "member", `member${K}1`);
      const stockRefs = [1, 2, 3].map((i) => doc(db, "stock", `stock${K}${i}`));
      const b = await t.get(billRef); const m = await t.get(memberRef); const ss = await Promise.all(stockRefs.map((r) => t.get(r)));
      t.update(billRef, { status: false, cancelBy: "พนักงาน", cancelTime: now() });
      t.set(doc(collection(db, "notification")), { heading: "ยกเลิกบิล", shopId: shop.shopId, notificationContent: "x", categoryId: 2, timestamp: serverTimestamp() });
      t.update(memberRef, { point: m.data().point - 1 });
      stockRefs.forEach((r, i) => t.update(r, { stock: ss[i].data().stock + 1, updateTime: serverTimestamp() }));
      void b;
    });
  },
  "tax-tx": async (db, shop) => {
    await runTransaction(db, async (t) => {
      const taxRef = doc(db, "taxId", shop.shopId); const billRef = doc(db, "bill", `bill${k(shop)}1`);
      const d = await t.get(taxRef);
      if (d.exists()) t.update(taxRef, { receipts: d.data().receipts + 1 }); else t.set(taxRef, { month: 11, receipts: 1 });
      t.update(billRef, { taxNumber: "000003", taxCustomer: { name: "ลูกค้า" } });
    });
  },
  "tax-tx-first": async (db, shop) => {
    await runTransaction(db, async (t) => {
      const taxRef = doc(db, "taxId", shop.shopId);
      await t.get(taxRef);
      t.set(taxRef, { month: 11, receipts: 1 });
    });
  },
  // ----- สมาชิก -----
  "member-get": (db, shop) => getDoc(doc(db, "member", `member${k(shop)}1`)),
  "member-list": (db, shop) => getDocs(query(collection(db, "member"), where("shopId", "==", shop.shopId))),
  "member-update": (db, shop) => updateDoc(doc(db, "member", `member${k(shop)}1`), { name: "ใหม่", tel: "0899999999" }),
  "member-tx-update": async (db, shop) => runTransaction(db, async (t) => {
    const r = doc(db, "member", `member${k(shop)}1`); const m = await t.get(r); t.update(r, { point: m.data().point + 5 });
  }),
  "member-credit-pay": async (db, shop) => runTransaction(db, async (t) => {
    const memberRef = doc(db, "member", `member${k(shop)}1`); const m = await t.get(memberRef);
    t.update(memberRef, { credit: 0, creditArray: m.data().creditArray });
    t.set(doc(collection(db, "notification")), { heading: "ลูกค้าชำระเงินเซ็น", shopId: shop.shopId, notificationContent: "x", categoryId: 5, timestamp: serverTimestamp() });
    t.set(doc(collection(db, "paidHistory")), { shopId: shop.shopId, memberId: `member${k(shop)}1`, pay: 20, timestamp: now(), staff: "พนักงาน" });
  }),
  "member-new": async (db, shop) => {
    const memberRef = doc(collection(db, "member"));
    await runTransaction(db, async (t) => {
      const listRef = doc(db, "memberList", "Z" + shop.shopId); // ยังไม่มี ⇒ get ของที่ไม่มี แล้ว set
      const d = await t.get(listRef);
      if (!d.exists()) t.set(listRef, { shopId: shop.shopId, members: [{ name: "ใหม่", tel: "0", id: memberRef.id }], updateTime: serverTimestamp() });
      t.set(memberRef, { name: "ใหม่", tel: "0", shopId: shop.shopId, point: 0, credit: 0, letter: "Z", timestamp: serverTimestamp() });
    });
  },
  "member-new-existing-list": async (db, shop) => runTransaction(db, async (t) => {
    const listRef = doc(db, "memberList", "Q" + shop.shopId); const d = await t.get(listRef);
    t.update(listRef, { members: [...d.data().members, { id: "m2", name: "", tel: "" }], updateTime: serverTimestamp() });
    t.set(doc(collection(db, "member")), { shopId: shop.shopId, name: "", tel: "", point: 0, credit: 0, letter: "Q", timestamp: serverTimestamp() });
  }),
  "member-delete-tx": async (db, shop) => runTransaction(db, async (t) => {
    const shopRef = doc(db, "shop", shop.docId); const memberRef = doc(db, "member", `member${k(shop)}1`); const listRef = doc(db, "memberList", "Q" + shop.shopId);
    const s = await t.get(shopRef); const l = await t.get(listRef);
    t.update(listRef, { members: l.data().members.filter((a) => a.id !== `member${k(shop)}1`), updateTime: serverTimestamp() });
    t.update(shopRef, { totalMember: s.data().totalMember - 1 });
    t.delete(memberRef);
  }),
  "member-web-delete": (db, shop) => deleteDoc(doc(db, "member", `member${k(shop)}1`)),
  "memberList-migrate-batch": async (db, shop) => {
    const b = writeBatch(db);
    for (const L of "ABCDEFGHIJ") b.set(doc(db, "memberList", L + shop.shopId), { members: [], shopId: shop.shopId, updateTime: serverTimestamp() });
    b.update(doc(db, "member", `member${k(shop)}1`), { letter: "B" });
    await b.commit();
  },
  "memberList-list": (db, shop) => getDocs(query(collection(db, "memberList"), where("shopId", "==", shop.shopId), where("updateTime", ">", new Date(2011, 0, 1)))),
  "memberList-web-upload": async (db, shop) => {
    const b = writeBatch(db);
    for (let i = 0; i < 20; i++) b.set(doc(collection(db, "member")), { shopId: shop.shopId, name: "n" + i, tel: "", point: 0, credit: 0, letter: "AB", timestamp: serverTimestamp() });
    await b.commit();
    await setDoc(doc(db, "memberList", "AB" + shop.shopId), { members: [], shopId: shop.shopId, updateTime: now() });
  },
  "paidHistory-list-by-member": (db, shop) => getDocs(query(collection(db, "paidHistory"), where("memberId", "==", `member${k(shop)}1`), where("timestamp", ">=", new Date(2025, 0, 1)))),
  // ----- สินค้า สต็อก -----
  "stock-list": (db, shop) => getDocs(query(collection(db, "stock"), where("shopId", "==", shop.shopId), where("updateTime", ">", new Date(2011, 0, 1)))),
  "stock-list-barcode": (db, shop) => getDocs(query(collection(db, "stock"), where("shopId", "==", shop.shopId), where("barcode", "==", `885${k(shop)}3`))),
  "stock-create": (db, shop) => addDoc(collection(db, "stock"), { shopId: shop.shopId, name: "ใหม่", barcode: "123", stock: 0, cost: 0, price: 0, timestamp: serverTimestamp(), updateTime: serverTimestamp() }),
  "stock-update": (db, shop) => updateDoc(doc(db, "stock", `stock${k(shop)}5`), { name: "แก้", price: 20, shopId: shop.shopId, updateTime: serverTimestamp() }),
  "stock-soft-delete": (db, shop) => updateDoc(doc(db, "stock", `stock${k(shop)}6`), { deleted: true, updateTime: serverTimestamp() }),
  "stock-delete": (db, shop) => deleteDoc(doc(db, "stock", `stock${k(shop)}7`)),
  "stock-tx-update": async (db, shop) => runTransaction(db, async (t) => {
    const r = doc(db, "stock", `stock${k(shop)}8`); const s = await t.get(r); t.update(r, { stock: s.data().stock + 5, expReport: [], updateTime: serverTimestamp() });
  }),
  "stock-tx-notify": async (db, shop) => runTransaction(db, async (t) => {
    const r = doc(db, "stock", `stock${k(shop)}9`); const s = await t.get(r);
    t.update(r, { stock: s.data().stock + 1, cost: 6, updateTime: serverTimestamp() });
    t.set(doc(collection(db, "notification")), { heading: "นำเข้า", shopId: shop.shopId, notificationContent: "x", categoryId: 4, timestamp: serverTimestamp() });
  }),
  "stock-unlink-tx": async (db, shop) => runTransaction(db, async (t) => {
    const K = k(shop); const refs = [doc(db, "stock", `stock${K}1`)]; const ss = await Promise.all(refs.map((r) => t.get(r)));
    refs.forEach((r, i) => t.update(r, { stock: ss[i].data().stock, linkDetail: [], linkNext: "", linkMultiply: "", linkQty: 0, linkId: "", id: r.id, updateTime: serverTimestamp() }));
    t.delete(doc(db, "stockLink", `link${K}1`));
    t.update(doc(db, "stock", `stock${K}2`), { deleted: true, updateTime: serverTimestamp() });
  }),
  "stockLink-list": (db, shop) => getDocs(query(collection(db, "stockLink"), where("shopId", "==", shop.shopId))),
  "stockLink-create": (db, shop) => addDoc(collection(db, "stockLink"), { shopId: shop.shopId, linkDetail: [] }),
  "stockLink-update": (db, shop) => updateDoc(doc(db, "stockLink", `link${k(shop)}1`), { linkDetail: [] }),
  "stockLink-delete": (db, shop) => deleteDoc(doc(db, "stockLink", `link${k(shop)}1`)),
  "stockLink-batch": async (db, shop) => {
    const K = k(shop); const b = writeBatch(db);
    const newRef = doc(collection(db, "stockLink"));
    b.set(newRef, { shopId: shop.shopId, linkDetail: [{ id: `stock${K}10` }] });
    for (let i = 10; i < 14; i++) b.update(doc(db, "stock", `stock${K}${i}`), { linkId: newRef.id, linkNext: "", linkQty: 0, linkMultiply: 1, stock: 1, updateTime: serverTimestamp() });
    b.update(doc(db, "stockLink", `link${K}1`), { linkDetail: [] });
    await b.commit();
  },
  "import-create-tx": async (db, shop) => runTransaction(db, async (t) => {
    const K = k(shop); const importRef = doc(collection(db, "importProduct"));
    const refs = [11, 12, 13].map((i) => doc(db, "stock", `stock${K}${i}`)); const ss = await Promise.all(refs.map((r) => t.get(r)));
    t.set(importRef, { shopId: shop.shopId, dateTime: now(), date: "20261106", product: [], supplierId: "" });
    refs.forEach((r, i) => t.update(r, { cost: 5, stock: ss[i].data().stock + 10, expReport: [], updateTime: serverTimestamp() }));
  }),
  "import-detail-tx": async (db, shop) => runTransaction(db, async (t) => {
    const K = k(shop); const importRef = doc(db, "importProduct", `imp${K}1`); const r = doc(db, "stock", `stock${K}14`);
    await t.get(importRef); const s = await t.get(r);
    t.update(importRef, { product: [] }); t.update(r, { stock: s.data().stock - 1, updateTime: serverTimestamp() });
  }),
  "import-list": (db, shop) => getDocs(query(collection(db, "importProduct"), where("shopId", "==", shop.shopId), orderBy("dateTime", "desc"), limit(30))),
  "import-list-web": (db, shop) => getDocs(query(collection(db, "importProduct"), where("shopId", "==", shop.shopId), where("date", "in", ["20261106"]))),
  "import-add": (db, shop) => addDoc(collection(db, "importProduct"), { shopId: shop.shopId, dateTime: now(), product: [] }),
  "import-update": (db, shop) => updateDoc(doc(db, "importProduct", `imp${k(shop)}1`), { product: [] }),
  "supplier-list": (db, shop) => getDocs(query(collection(db, "supplier"), where("shopId", "==", shop.shopId))),
  "supplier-add": (db, shop) => addDoc(collection(db, "supplier"), { shopId: shop.shopId, name: "ใหม่" }),
  "supplier-update": (db, shop) => updateDoc(doc(db, "supplier", `sup${k(shop)}1`), { name: "แก้", shopId: shop.shopId }),
  "supplier-delete": (db, shop) => deleteDoc(doc(db, "supplier", `sup${k(shop)}1`)),
  "requisition-tx": async (db, shop) => runTransaction(db, async (t) => {
    const K = k(shop); const refs = [15, 16].map((i) => doc(db, "stock", `stock${K}${i}`)); const ss = await Promise.all(refs.map((r) => t.get(r)));
    refs.forEach((r, i) => t.update(r, { stock: ss[i].data().stock - 1, updateTime: serverTimestamp() }));
    t.set(doc(collection(db, "requisition")), { shopId: shop.shopId, billDate: "20261106", product: [] });
    t.set(doc(collection(db, "notification")), { heading: "เบิก", shopId: shop.shopId, notificationContent: "", categoryId: 6, timestamp: serverTimestamp() });
  }),
  "requisition-list": (db, shop) => getDocs(query(collection(db, "requisition"), where("shopId", "==", shop.shopId), where("billDate", "in", ["20261106"]))),
  "uploadProduct-create": (db, shop) => addDoc(collection(db, "uploadProduct"), { shopId: shop.shopId, barcodes: ["885"], timestamp: now() }),
  "priceTag-create": async (db, shop) => { const r = doc(collection(db, "priceTag")); await setDoc(r, { shopId: shop.shopId, products: [], timestamp: now() }); },
  "stockReport-list": (db, shop) => getDocs(query(collection(db, "stockReport"), where("shopId", "==", shop.shopId), orderBy("timestamp", "desc"), limit(25))),
  // ----- โปร ค่าใช้จ่าย -----
  "promotion-create": async (db, shop) => { const r = doc(collection(db, "promotion")); await setDoc(r, { shopId: shop.shopId, id: r.id, name: "ใหม่" }); },
  "promotion-list": (db, shop) => getDocs(query(collection(db, "promotion"), where("shopId", "==", shop.shopId))),
  "promotion-update": (db, shop) => updateDoc(doc(db, "promotion", `pro${k(shop)}1`), { shopId: shop.shopId, id: `pro${k(shop)}1`, name: "แก้", status: false }),
  "promotion-delete": (db, shop) => deleteDoc(doc(db, "promotion", `pro${k(shop)}1`)),
  "expense-list": (db, shop) => getDocs(query(collection(db, "expense"), where("shopId", "==", shop.shopId))),
  "expense-create": async (db, shop) => setDoc(doc(collection(db, "expense")), { shopId: shop.shopId, name: "ใหม่", price: 1, timestamp: now() }),
  "expense-update": (db, shop) => updateDoc(doc(db, "expense", `exp${k(shop)}1`), { price: 2 }),
  "expense-delete": (db, shop) => deleteDoc(doc(db, "expense", `exp${k(shop)}1`)),
  "expenseReport-list": (db, shop) => getDocs(query(collection(db, "expenseReport"), where("shopId", "==", shop.shopId), orderBy("month", "desc"))),
  "expenseReport-tx": async (db, shop) => runTransaction(db, async (t) => {
    const r = doc(db, "expenseReport", `rep${k(shop)}1`); const d = await t.get(r); t.update(r, { expenses: [...d.data().expenses, { id: "e2", price: 1 }] });
  }),
  "expenseReport-create-tx": async (db, shop) => runTransaction(db, async (t) => {
    const r = doc(db, "expenseReport", `new${k(shop)}202612`); const d = await t.get(r);
    if (!d.exists()) t.set(r, { shopId: shop.shopId, month: "202612", expenses: [] });
  }),
  // ----- กะ เข้างาน แจ้งเตือน -----
  "shift-get": (db, shop) => getDoc(doc(db, "shift", shop.docId + "-shift")),
  "shift-open-batch": async (db, shop) => {
    const b = writeBatch(db);
    b.update(doc(db, "shift", shop.docId + "-shift"), { status: true, openCash: "100", openName: "พนักงาน", openId: shop.staff, openTime: now(), lastShiftDate: "20261106", shiftCount: 1 });
    b.set(doc(collection(db, "notification")), { heading: "เปิดกะ", shopId: shop.shopId, notificationContent: "", categoryId: 1, timestamp: serverTimestamp() });
    await b.commit();
  },
  "shift-during-tx": async (db, shop) => runTransaction(db, async (t) => {
    const r = doc(db, "shift", shop.docId + "-shift"); const d = await t.get(r);
    t.update(r, { duringShift: [...d.data().duringShift, { type: 1, amount: "10", comment: "", staff: "พนักงาน", staffId: shop.staff, timestamp: now() }] });
    t.set(doc(collection(db, "notification")), { heading: "นำเงินเข้า", shopId: shop.shopId, notificationContent: "", categoryId: 1, timestamp: serverTimestamp() });
  }),
  "shift-close-tx": async (db, shop) => runTransaction(db, async (t) => {
    const r = doc(db, "shift", shop.docId + "-shift"); await t.get(r);
    t.set(doc(collection(db, "shiftHistory")), { shopId: shop.shopId, id: shop.docId + "-shift", posId: "pos-1", lastShiftDate: "20261106", closeCash: "100", closeTime: now() });
    t.update(r, { status: false, duringShift: [] });
    t.set(doc(collection(db, "notification")), { heading: "ปิดกะ", shopId: shop.shopId, notificationContent: "", categoryId: 1, timestamp: serverTimestamp() });
  }),
  "shiftHistory-list": (db, shop) => getDocs(query(collection(db, "shiftHistory"), where("shopId", "==", shop.shopId), where("lastShiftDate", "in", ["20261105"]))),
  "pos-tx": async (db, shop) => runTransaction(db, async (t) => {
    const shopRef = doc(db, "shop", shop.docId); const shiftRef = doc(collection(db, "shift"));
    t.set(shiftRef, { shopId: shop.shopId, posId: "pos-2", status: false, duringShift: [], openTime: "", lastShiftDate: "20230909", shiftCount: 0 });
    t.delete(doc(db, "shift", shop.docId + "-shift"));
    t.update(shopRef, { POSs: [{ id: "pos-2", name: "แคชเชียร์ 2", shiftId: shiftRef.id }] });
  }),
  "printer-pos-tx": async (db, shop) => runTransaction(db, async (t) => {
    const shopRef = doc(db, "shop", shop.docId); const s = await t.get(shopRef); const shiftRef = doc(collection(db, "shift"));
    t.set(shiftRef, { shopId: shop.shopId, posId: "pos-1", id: shiftRef.id, status: false, duringShift: [] });
    t.update(shopRef, { POSs: s.data().POSs.map((p) => ({ ...p, shiftId: shiftRef.id })) });
  }),
  "checkIn-get-absent": (db, shop) => getDoc(doc(db, "checkIn", shop.shopId + U.outsider)),
  "checkIn-get": (db, shop) => getDoc(doc(db, "checkIn", shop.shopId + shop.staff)),
  "checkIn-set": (db, shop) => setDoc(doc(db, "checkIn", shop.shopId + shop.staff), { profileId: shop.staff, shopId: shop.shopId, clockIn: serverTimestamp(), clockInImage: "url", billDate: "20261106100000", id: "" }),
  "checkIn-out": async (db, shop) => {
    await addDoc(collection(db, "checkInHistory"), { shopId: shop.shopId, profileId: shop.staff, id: shop.shopId + shop.staff, clockIn: now(), clockOut: serverTimestamp(), clockOutImage: "url", billDate: "20261106" });
    await deleteDoc(doc(db, "checkIn", shop.shopId + shop.staff));
  },
  "checkInHistory-list-own": (db, shop) => getDocs(query(collection(db, "checkInHistory"), where("id", "==", shop.shopId + shop.staff), orderBy("clockIn", "desc"), limit(10))),
  "checkInHistory-list-web": (db, shop) => getDocs(query(collection(db, "checkInHistory"), where("shopId", "==", shop.shopId), where("billDate", "in", ["20261106"]))),
  "bill-list-web": (db, shop) => getDocs(query(collection(db, "bill"), where("shopId", "==", shop.shopId), where("billDate", "in", ["20261106"]))),
  "notification-add": (db, shop) => addDoc(collection(db, "notification"), { heading: "เข้า - ออกงาน", shopId: shop.shopId, notificationContent: "", categoryId: 3, timestamp: serverTimestamp() }),
  "notification-list": (db, shop) => getDocs(query(collection(db, "notification"), where("shopId", "==", shop.shopId), orderBy("timestamp", "desc"), limit(30))),
  // ----- ร้าน -----
  "shop-list-by-shopId": (db, shop) => getDocs(query(collection(db, "shop"), where("shopId", "==", shop.shopId))),
  "shop-get": (db, shop) => getDoc(doc(db, "shop", shop.docId)),
  "shop-update-field": (db, shop) => updateDoc(doc(db, "shop", shop.docId), { receipt: { header: "หัว" }, cutOff: "00:00" }),
  "shop-update-pos": (db, shop) => runTransaction(db, async (t) => {
    const r = doc(db, "shop", shop.docId); const s = await t.get(r); t.update(r, { POSs: [...s.data().POSs, { id: "pos-x", name: "x" }] });
  }),
  "shop-staff-password-tx": (db, shop) => runTransaction(db, async (t) => {
    const r = doc(db, "shop", shop.docId); const s = await t.get(r);
    t.update(r, { humanResource: s.data().humanResource.map((h) => (h.id === shop.staff ? { ...h, password: "9999" } : h)) });
  }),
  "shop-update-hr-noti": (db, shop) => runTransaction(db, async (t) => {
    const r = doc(db, "shop", shop.docId); const s = await t.get(r);
    t.update(r, { humanResource: [...s.data().humanResource, { id: U.outsider, position: [], status: "active", rights: [], name: "ใหม่", password: "" }], notiShift: [shop.owner], notiCancelBill: [] });
  }),
  "pgWebhook-listen": (db, shop) => listenOnce(doc(db, "pgWebhook", `pg${k(shop)}1`)),
  "stock-listen": (db, shop) => listenOnce(query(collection(db, "stock"), where("shopId", "==", shop.shopId))),
  "billId-get": (db, shop) => getDoc(doc(db, "billId", shop.docId)),
};

// ---------------- ทางที่ไม่ผูกร้าน หรือผูกตัวบัญชี ----------------
export const OTHER_SCENARIOS = {
  "profile-create-own": (db, me) => setDoc(doc(db, "profile", me), { name: "ใหม่", tel: "0", email: "a@b.c", timestamp: serverTimestamp(), port: [], currentLogin: { shopId: "", printer: [], rights: [] }, wallPaper: {} }),
  "profile-get-own": (db, me) => getDoc(doc(db, "profile", me)),
  "profile-update-own": (db, me) => updateDoc(doc(db, "profile", me), { currentLogin: { shopId: "", printer: [], rights: [] } }),
  "profile-get-other": (db) => getDoc(doc(db, "profile", U.staffA)),
  "profile-find-by-tel": (db) => getDocs(query(collection(db, "profile"), where("tel", "==", "0800000000"))),
  "shop-find-by-tel": (db) => getDocs(query(collection(db, "shop"), where("tel", "==", "0811111111"))),
  "admin-config-get": (db) => Promise.all(["adminConfig", "updateShopchamp", "package", "apk", "hardware", "admin", "question"].map((d) => getDoc(doc(db, "admin", d)))),
  "admin-counter-order-tx": (db, me, shop, counter = "packageNumber", order = "packageOrder") => runTransaction(db, async (t) => {
    const cRef = doc(db, "admin", counter); const c = await t.get(cRef);
    t.update(cRef, { value: c.data().value + 1, timestamp: now() });
    t.set(doc(collection(db, order)), { shopId: shop.shopId, shopName: "x", profileId: me, timestamp: now(), orderNumber: "000006", net: 100 });
    t.set(doc(collection(db, "notification")), { heading: "สั่งซื้อ", shopId: shop.shopId, notificationContent: "", categoryId: 99, timestamp: serverTimestamp() });
  }),
  "shopchamShopId-newShop-tx": (db, me) => runTransaction(db, async (t) => {
    const idRef = doc(db, "shopchamShopId", "numOfStore"); const c = await t.get(idRef);
    const shopRef = doc(collection(db, "shop")); const shiftRef = doc(collection(db, "shift")); const profileRef = doc(db, "profile", me);
    await t.get(profileRef);
    t.set(shopRef, { name: "ร้านใหม่", tel: "0", scShopId: c.data().total + 1, id: shopRef.id, shopId: shopRef.id, humanResource: [{ id: me, position: ["001"], status: "active", name: "", imageId: "", email: "", rights: initialRights }], POSs: [{ id: "p", shiftId: shiftRef.id }], dateTime: now(), notiShift: [me] });
    t.set(shiftRef, { id: shiftRef.id, posId: "p", shopId: shopRef.id, status: false, duringShift: [] });
    t.update(idRef, { total: c.data().total + 1 });
    t.update(profileRef, { port: [{ shopId: shopRef.id, position: ["001"] }], currentLogin: { shopId: shopRef.id, rights: initialRights } });
  }),
  "shop-create-slice": async (db, me) => { const r = doc(collection(db, "shop")); await setDoc(r, { name: "x", shopId: r.id, humanResource: [{ id: me, position: ["001"] }] }); },
  "legacy-profile-migrate-tx": (db, me, shop) => runTransaction(db, async (t) => {
    // ร้านรุ่นเก่าที่ยังไม่มี profile (LoadingScreen.js:91-152) · เจ้าของ = field shopId
    const profileRef = doc(db, "profile", me); const shopRef = doc(db, "shop", shop.docId); const shiftRef = doc(collection(db, "shift"));
    t.set(profileRef, { name: "", currentLogin: { shopId: me, printer: [], rights: initialRights }, port: [{ position: ["001"], shopId: shop.shopId, shopName: "", logo: "" }], email: "", tel: "" });
    t.set(shiftRef, { shopId: shop.shopId, posId: "p", id: shiftRef.id, status: false, duringShift: [] });
    t.update(shopRef, { humanResource: [{ id: me, position: ["001"], name: "", imageId: "", email: "", tel: "" }], POSs: [{ id: "p", shiftId: shiftRef.id }] });
  }),
  "admin-counter-package": (db, me, shop) => OTHER_SCENARIOS["admin-counter-order-tx"](db, me, shop, "packageNumber", "packageOrder"),
  "admin-counter-hardware": (db, me, shop) => OTHER_SCENARIOS["admin-counter-order-tx"](db, me, shop, "hardwareNumber", "hardwareOrder"),
  "admin-counter-image": (db, me, shop) => OTHER_SCENARIOS["admin-counter-order-tx"](db, me, shop, "imageNumber", "imageOrder"),
  "admin-counter-stock": (db, me, shop) => OTHER_SCENARIOS["admin-counter-order-tx"](db, me, shop, "stockNumber", "stockOrder"),
  "shop-list-shopId-other": (db) => getDocs(query(collection(db, "shop"), where("shopId", "==", "shopBbbbbbbbbbbbbbbb"))),
  "team-franchise-list-all": (db) => getDocs(collection(db, "franchise")),
  "product-list-barcode": (db) => getDocs(query(collection(db, "product"), where("barcode", "==", "8850001"))),
  "product-add": (db) => addDoc(collection(db, "product"), { barcode: "8850002", name: "ใหม่", unit: "ชิ้น", imageId: "" }),
  "product-update-image": (db) => updateDoc(doc(db, "product", "prod1"), { imageId: "url" }),
  "buildings-read": (db) => getDocs(query(collection(db, "buildings"), orderBy("geohash"), limit(10))),
  "buildings-add": (db) => addDoc(collection(db, "buildings"), { g: { geohash: "w4", geopoint: null }, name: "ร้าน" }),
  "buildings-update": (db) => updateDoc(doc(db, "buildings", "LON"), { geohash: "gcpvj0", lat: 51.5, lng: 0.1278 }),
  "deletedUser-create": (db, me) => addDoc(collection(db, "deletedUser"), { authenBy: "password", deleteReason: "", deletedAt: serverTimestamp(), isDeleteSuccess: true, uid: me }),
  "deletedUser-update": (db) => updateDoc(doc(db, "deletedUser", "del1"), { isDeleteSuccess: false }),
  "loginByScan-app-write-uid": (db, me) => updateDoc(doc(db, "loginByScan", "scan1"), { uid: me }),
  "loginByScan-web-create-listen": async (db) => {
    const r = doc(collection(db, "loginByScan"));
    await setDoc(r, { uid: "", docId: r.id, timestamp: now() });
    await listenOnce(query(collection(db, "loginByScan"), where("docId", "==", r.id)));
    await deleteDoc(r);
  },
  "receiptGuard-get-absent": (db) => getDoc(doc(db, "receiptGuard", "uuid-not-yet")),
  "uploadProduct-get-by-id": (db) => getDoc(doc(db, "uploadProduct", "upA1")),
  "priceTag-get-by-id": (db) => getDoc(doc(db, "priceTag", "tagA1")),
  "shared-upload-stock": async (db, me, shop) => {
    const b = writeBatch(db);
    for (let i = 0; i < 5; i++) b.set(doc(collection(db, "stock")), { shopId: shop.shopId, name: "อัป" + i, barcode: "9" + i, stock: 0, timestamp: serverTimestamp(), updateTime: serverTimestamp() });
    await b.commit();
    await updateDoc(doc(db, "shop", shop.docId), { smartCategory: [{ id: "c1", name: "หมวด" }] });
  },
  // ----- แฟรนไชส์ -----
  "franchise-list-mine": (db, me) => getDocs(query(collection(db, "franchise"), where("humanResource", "array-contains", me))),
  "franchise-get": (db) => getDoc(doc(db, "franchise", FR)),
  "franchise-update-staff": (db, me) => updateDoc(doc(db, "franchise", FR), { humanRight: [{ id: me, rights: [] }], humanResource: [me] }),
  "franchise-update-category": (db) => updateDoc(doc(db, "franchise", FR), { warehouseCategory: [{ id: "w", name: "หมวด" }] }),
  "franchise-create-then-staff": async (db, me) => {
    const r = doc(collection(db, "franchise"));
    await setDoc(r, { name: "ใหม่", timestamp: now(), humanResource: [], humanRight: [] });
    await updateDoc(r, { humanRight: [{ id: me, rights: [] }], humanResource: [me] });
  },
  "franchise-new-empty-get": (db) => getDoc(doc(db, "franchise", FR_EMPTY)),
  "franchise-shops-by-franchiseId": (db) => getDocs(query(collection(db, "shop"), where("franchiseId", "==", FR))),
  "franchise-bills": (db) => getDocs(query(collection(db, "bill"), where("franchiseId", "==", FR), where("billDate", "in", ["20261106"]))),
  "franchise-attach-branch-tx": (db, me, shop) => runTransaction(db, async (t) => {
    const r = doc(db, "shop", shop.docId); await t.get(r); t.update(r, { franchiseId: FR });
  }),
  "franchise-stockLink-list": (db) => getDocs(query(collection(db, "stockLink"), where("franchiseId", "==", FR))),
  "franchise-stockLink-create": async (db) => { const r = doc(collection(db, "stockLink")); await setDoc(r, { id: r.id, franchiseId: FR, linkDetail: [] }); },
  "franchise-stockLink-update": (db) => updateDoc(doc(db, "stockLink", "frLink1"), { id: "frLink1", franchiseId: FR, linkDetail: [{ id: "x" }] }),
  "franchise-stockLink-delete": (db) => deleteDoc(doc(db, "stockLink", "frLink1")),
  "warehouse-list": (db) => getDocs(query(collection(db, "warehouseItem"), where("franchiseId", "==", FR))),
  "warehouse-create": (db) => setDoc(doc(collection(db, "warehouseItem")), { name: "ใหม่", timestamp: serverTimestamp(), franchiseId: FR, stock: 0 }),
  "warehouse-update": (db) => updateDoc(doc(db, "warehouseItem", "wh1"), { name: "แก้", imageId: "" }),
  "warehouse-delete": (db) => deleteDoc(doc(db, "warehouseItem", "wh1")),
  // ----- ทีมงาน (care · หน้าทดสอบ) -----
  "team-admin-package-update": (db) => updateDoc(doc(db, "admin", "package"), { payment: [] }),
  "team-admin-config-ads": (db) => updateDoc(doc(db, "admin", "adminConfig"), { mainAds: [{ id: 1 }] }),
  "team-cross-shop-read": (db) => Promise.all([getDoc(doc(db, "bill", "billB1")), getDocs(query(collection(db, "stock"), where("shopId", "==", "shopBbbbbbbbbbbbbbbb")))]),
  "team-cross-shop-write": (db) => updateDoc(doc(db, "stock", "stockB1"), { stock: 1 }),
  "team-care-collections": (db) => Promise.all(["adjustStock", "importStock", "mainAds", "renter", "productCobrand", "checkout"].map((c) => getDocs(query(collection(db, c), limit(1))))),
  "team-care-profile-write": (db) => updateDoc(doc(db, "profile", U.ownerB), { name: "แก้โดยทีมงาน" }),
};
