// pos/e2e/_old.js — ตัวอ่านของแอปเก่าและ server เก่า ที่ใช้พิสูจน์ว่าเอกสารที่ handler ใหม่เขียน "ของเก่ายังอ่านได้" (ก้อน 4 · DEV-0001)
//
// สูตรมาจาก 2 ที่ (ไม่แก้สูตร):
//   ① ไม้บรรทัดของเดิม `lanes/dev/source/compare/old-logic/*.js` (คัดคำต่อคำจากแอปเก่าและ server ที่ live · โหลดตรงจากบ้าน)
//      ตั้ง OLD_LOGIC_DIR ได้ · ไม่พบ = เทสส่วน compat ข้าม (skip) พร้อมบอกเหตุ
//   ② query ของ route เก่าที่แอปเก่าเรียก คัดลอกมาที่นี่ (ไฟล์ต้นทางแช่แข็ง require ตรงไม่ได้ เพราะผูก env.json และ middleware)
//      - oldBillList    ← functions/apis/bill.js:18-60  (/bill/test · จอประวัติบิลของแอปเก่า BillHistoryScreen.js:304-334)
//      - oldBillSummary ← functions/apis/bill.js:64-93  (/bill/summary)
//      - oldShiftTest   ← functions/apis/shift.js:236-262 (/shift/test · จอกะของแอปเก่า) + manageSummary ของ old-logic/shift.js
//   ③ ส่วนพิมพ์ซ้ำของแอปเก่าที่อ่าน field บิลตรง ๆ ไม่มีค่าตั้งต้น (main3 src/hook/usePrintAction.js:59-67 · :198-206)
"use strict";

const fs = require("fs");
const path = require("path");

const OLD_DIR = process.env.OLD_LOGIC_DIR || path.resolve(__dirname, "../../../../lanes/dev/source/compare/old-logic");
const HAVE_OLD = fs.existsSync(path.join(OLD_DIR, "shift.js"));
const skipOld = HAVE_OLD ? false : `ไม่พบ old-logic ที่ ${OLD_DIR} (ตั้ง OLD_LOGIC_DIR)`;
const old = (name) => require(path.join(OLD_DIR, `${name}.js`));

/** รันสูตรเก่าที่อ่าน `new Date()` เอง ใต้นาฬิกาที่ตรึงไว้ (process รันด้วย TZ=Asia/Bangkok จาก run.js) */
function withFrozenDate(iso, fn) {
  const Real = global.Date;
  const fixed = new Real(iso).getTime();
  class Frozen extends Real {
    constructor(...a) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  }
  global.Date = Frozen;
  try { return fn(); } finally { global.Date = Real; }
}

// ── functions/apis/bill.js:18-60 (/bill/test) · คัดคำต่อคำ เปลี่ยนแค่รับ db + คืนค่าแทน res.send ──
async function oldBillList(db, { shopId, lastDoc, limit, startDate, endDate }) {
        let query = db.collection('bill')
            .where("shopId", "==", shopId)
            .where('dateTime', '>', new Date(startDate))
            .where('dateTime', '<=', new Date(endDate))
            .orderBy('dateTime', 'desc')
            .select("receiptNumber", "dateTime", "moneyMustPaid", "cashierName", "payment",
                "reason", "voidStaff", "void")
            .limit(limit);

        if (lastDoc) {
            const lastVisible = await db.collection('bill').doc(lastDoc.id).get();
            if (lastVisible.exists) {
                query = query.startAfter(lastVisible);
            }
        }

        const snapshot = await query.get();
        if (snapshot.empty) {
            return { newData: [], newLastDoc: null };
        }

        let newData = snapshot.docs.map(doc => ({
            id: doc.id,
            void:false,
            ...doc.data(),
            dateTime:doc.data().dateTime.toDate()
        }));

        let newLastDoc = snapshot.docs[snapshot.docs.length - 1];

        newData = newData.map(a=>({...a,voidStatus:a.void}));

        return {
            newData,
            newLastDoc: newLastDoc ? { id: newLastDoc.id } : null
        };
}

// ── functions/apis/bill.js:64-93 (/bill/summary) ──
async function oldBillSummary(db, { shopId, startDate, endDate }) {
        let billData = []
        const checkoutDocs = await db.collection('bill')
            .where("shopId", "==", shopId)
            .where('dateTime', '>', new Date(startDate))
            .where('dateTime', '<=', new Date(endDate))
            .orderBy('dateTime', 'desc')
            .select("moneyMustPaid",'void')
            .get();

        billData = checkoutDocs.docs.map(doc => ({
            ...doc.data(),
            id: doc.id
        }));
        let qty = 0;
        let totalSale = 0;
        billData.forEach(item=>{
            if(!item.void){
                qty ++
                totalSale += item.moneyMustPaid
            }
        })
        return { qty, totalSale };
}

// ── functions/apis/shift.js:236-262 (/shift/test) ── initialShift ไม่อยู่ใน old-logic ⇒ ใช้ {} (ไม่กระทบการกรอง)
async function oldShiftTest(db, { smartCategory = [], shiftId }) {
  const { formatTime, initialCheckOut, manageSummary } = old("shift");
  const initialShift = {};
  let shiftData;
        let billData = []
            const shiftDoc = await db.collection('shift').doc(shiftId).get();
            shiftData = { ...initialShift, ...shiftDoc.data(), id:shiftId }

            if(shiftData.openId){ // เปิดกะแล้ว
                const { status, openTime } = shiftData
                if(status){
                  const checkoutDocs = await db.collection('bill')
                        .where("shiftId", "==", shiftId)
                        .where("dateTime", ">", formatTime(openTime))
                        .select("manualDiscount", "moneyMustPaid", "payment", "pointDiscount", "product", "productDiscount", "change",  "rounding",
                          "campaign","void","cashierId", "cashierName",'vatAmount' )
                        .get();

                        billData = checkoutDocs.docs.map(doc => ({
                            ...initialCheckOut,
                            ...doc.data(),
                            id: doc.id
                        }));
                }
            }
            const selectedBill = billData.filter(a => !a.void);
            const selectedVoidBill = billData.filter(a => a.void);
            const thisSummary = manageSummary({ selectedBill, smartCategory, selectedVoidBill })
  return { shiftData, thisSummary, billData };
}

// ── main3 src/hook/usePrintAction.js:59-67 · :198-206 (พิมพ์ใบกำกับเต็มจากจอประวัติบิล · ข้อมูล = bill doc ทั้งก้อน) ──
//   ตัดส่วนเครื่องพิมพ์ · เหลือเฉพาะนิพจน์ที่อ่าน field ของบิล (useToLocale = String)
function oldPrintFields(data) {
  const useToLocale = (n) => String(n);
  const { summary } = old("money");
                        const { moneyMustPaid, vatAmount, cashierName,
                            payment, pointDiscount, productDiscount,
                            dateTime, receiptNumber, taxCustomer, taxNumber, taxs,
                            round, manualDiscount, campaign, rounding = 0, posNumber = '', product = [], vatType = 'Include' } = data ;

                        const newPayment = payment.map(a=>({...a,amount:useToLocale(Number(a.amount))}))
  return {
    newPayment,
                            discount:useToLocale(Number(manualDiscount) + Number(pointDiscount.value) +Number(productDiscount)),
                            campaign:campaign.length>0?useToLocale(summary(campaign,'discount')):'',
  };
}

module.exports = { HAVE_OLD, skipOld, old, withFrozenDate, oldBillList, oldBillSummary, oldShiftTest, oldPrintFields, OLD_DIR };
