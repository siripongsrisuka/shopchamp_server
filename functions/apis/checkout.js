const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch-commonjs");   // config adjust of "node-fetch" ,for compatible with all javascript,ESM,node version

const app = express();
app.use(cors({origin:true}));

var db = admin.firestore(); // Initialize Firestore database

// https://asia-southeast2-shopcham-24b0b.cloudfunctions.net/users/checkPhoneRegister/+668531882

const scEndPoint = "https://asia-southeast2-shopcham-24b0b.cloudfunctions.net";

// checkPhoneRegister
app.post("/test", async (req, res) => {
 
    try{
        // functions.logger.info("function:checkPhoneRegister:info",{message:"Found Registered User"});
        await db.runTransaction(async (transaction) => {
            const  billIdRef = db.collection("billId").doc(id)
            const newBillRef = db.collection('bill').doc()
            const minusDocs = [];
            for (const { id } of newStock) {
                const stockRef = db.collection("stock").doc(id);
                minusDocs.push(transaction.get(stockRef));
            };
            const memberRef = currentMember.id?db.collection('member').doc(currentMember.id):null;
            
            const billIdDoc = await transaction.get(billIdRef)
            if (!billIdDoc.exists) {
                transaction.set(billIdRef, { month: new Date().getMonth() + 1, receipts: 1 });
            } else {
                const { month, receipts } = billIdDoc.data();
                if (new Date().getMonth() + 1 === month) {
                    receiptNumber = stringReceiptNumber(receipts + 1);
                    transaction.update(billIdRef, { receipts: receipts + 1 });
                } else {
                    transaction.update(billIdRef, { receipts: 1, month: new Date().getMonth() + 1 });
                }
            }
            finalReceipt.receiptNumber = receiptNumber
            //1. Update stock
            for (let i = 0; i < newStock.length; i++) {
                const { id, qty: qty2 } = newStock[i];
                const minusDoc = await minusDocs[i];
    
                if (!minusDoc.exists) throw new Error(`Product ${id} not found`);
    
                const { stock, name, unit, safetyStock } = minusDoc.data();
                const { status, qty } = checkUndefinedOrNaN(safetyStock, { status: false, qty: 0 });
    
                let stockPrev = Number(nanToZero(stock));
                let stockNext = stockPrev - Number(qty2);
    
                transaction.update(db.collection("stock").doc(id), {
                    stock: stockNext,
                    updateTime: admin.firestore.FieldValue.serverTimestamp()
                });
    
                minusStockResult.push({
                    stockPrev, stockNext, name, unit, status, qty: Number(qty)
                });
            }

            //2. Update member if exists
            if (memberRef) { 
                const memberDoc = await transaction.get(memberRef);

                if (!memberDoc.exists) throw new Error("Member not found");

                const { credit = 0, point = 0, bought = [] } = memberDoc.data();
                const { diffPoint, diffCredit, moneyMustPaid } = memberChange;

                let newBought = [...bought];
                let checkBought = findInArray(newBought, 'yearMonth', yearMonth(new Date()));

                if (checkBought && checkBought.yearMonth) {
                    checkBought.buy += moneyMustPaid;
                    checkBought.time += 1;
                } else {
                    newBought.push({
                        yearMonth: yearMonth(new Date()),
                        buy: moneyMustPaid,
                        time: 1,
                        year: stringY(new Date())
                    });
                }

                let newPoint = point + Number(diffPoint);
                let newCredit = Number(credit) + Number(diffCredit);

                transaction.update(memberRef, {
                    credit: newCredit,
                    point: newPoint,
                    bought: newBought,
                    lastTime: new Date()
                });

                memberData = {
                    id: currentMember.id,
                    ...memberDoc.data(),
                    credit: newCredit, 
                    point: newPoint, 
                    bought: newBought, 
                    lastTime: new Date()
                };
            }

            // 3. Add new checkout
            transaction.set(newBillRef, finalReceipt);
        });
        res.status(200).send(billDoc.data());
    }catch(err){
        functions.logger.error("function:checkPhoneRegister:error",err)
        res.status(500).send({phoneNumber:req.params.phoneNumber, message:"Internal Server Error",error:err})
    }
});

function summary(arr,propertise){
  let sum = arr?.reduce((a, b) => Number(a) + (Number(b[propertise]) || 0), 0);
  return sum
};

const getCurrentDateInfo = (type) => {
    const now = new Date();
    return type === 'month' ? now.getMonth() + 1 : now.getDate();
};

const getStringReceipt = (type, number) => {
    return type === 'month' ? stringReceiptNumber(number) : stringReceiptNumberDay(number);
};

const stringReceiptNumberDay = (receipts) => {
    const date = new Date()
    const cDateTime =
        date.getFullYear().toString().padStart(4,"0")+"" +
        parseInt(date.getMonth()+1).toString().padStart(2,"0") +""+
        date.getDate().toString().padStart(2,"0")+""+
        receipts.toString().padStart(6,"0")

    return cDateTime;  // 202309000123
};

const stringReceiptNumber = (receipts) => {
    const date = new Date()
    const cDateTime =
        date.getFullYear().toString().padStart(4,"0")+"" +
        parseInt(date.getMonth()+1).toString().padStart(2,"0") +""+
        receipts.toString().padStart(6,"0")

    return cDateTime;  // 202309000123
};

function leanProduct(products) {
  return products.map(({ id, qty, net, name, totalPrice, totalCost, priceType,
    category, consignment
   }) => ({
    id,
    qty,
    net,
    name,
    totalPrice,
    totalCost,
    priceType,
    category, 
    consignment
  }));
};

function manageFortune(currentFortune) {
  const promoMap = {
    '5': 100,
    '11': 100,
    '6': 1000,
    '12': 1000,
  };

  return Object.entries(promoMap)
    .some(([id, max]) => currentFortune.some(a => a.promotionId === id))
    ? [
        ...(currentFortune.some(a => ['5', '11'].includes(a.promotionId))
          ? [Math.floor(Math.random() * 100).toString().padStart(2, "0")]
          : []),
        ...(currentFortune.some(a => ['6', '12'].includes(a.promotionId))
          ? [Math.floor(Math.random() * 1000).toString().padStart(3, "0")]
          : []),
      ]
    : [];
};

function nanToZero(data) { // ถ้าเป็น string ก็ return ออกตรงๆ
  return Number.isNaN(data) || data === undefined ? 0 : data;
};

const yearMonth = (today) => {
    // const today = new Date();
    const cDateTime =
        today.getFullYear().toString().padStart(4,"0")+
        parseInt(today.getMonth()+1).toString().padStart(2,"0") 

    return cDateTime;  // 202211
};

const stringY= (day) => {
    const Y = day.getFullYear().toString();
    return Y;
};

const leanPaymentChannel = (paymentChannel) =>
  paymentChannel.map(({ type, imageId, ...rest }) => rest);

app.post("/billByPack", async (req, res) => {
    const {
        paymentChannel,
        creditPoint,
        currentCart,
        smartPoint,
        currentMember,
        usedPoint,
        manualDiscount,
        pointDiscount,
        productDiscount,
        moneyMustPaid,
        receiptNumber,
        billDate,
        dateTime,
        shopId,
        posId,
        pointToItem,
        posNumber,
        shiftId,
        cashierId,
        cashierName,
        campaign,
        vatAmount,
        vatType,
        rounding,
        note,
        receiptType,
        receiptUUID = '',
        id
    } = req.body;

        const currentCredit = paymentChannel.find(a=>a.id===3)?.amount || 0;

        let gainPoint = 0
        let diffPoint = 0
        let existPoint = 0
        if (currentMember.id && (currentCredit===0 || creditPoint)) { // มีสมาชิกและไม่เช็น
            const { rate, point, date, days } = smartPoint;
            const enableProduct = currentCart.filter(a => a.pointStatus);
            
            let multiple = 1;
            const today = new Date();
            
            const findDate = date.find(a => a.id === today.getDate())?.value;
            if (findDate) multiple *= Number(findDate); // ได้แต้มเพิ่มตามวันที่
            
            const findDay = days.find(a => a.id === today.getDay())?.value;
            if (findDay) multiple *= Number(findDay); // ได้แต้มเพิ่มตามวัน
            
            gainPoint = Math.floor((multiple * summary(enableProduct, 'net') * point) / rate);
            diffPoint = gainPoint - usedPoint
        }
        const change = summary(paymentChannel,'change');
        let finalReceipt = {
                manualDiscount,
                pointDiscount,
                productDiscount,
                moneyMustPaid,
                // receiptNumber:getStringReceipt(receiptType, 1),
                billDate,
                dateTime,
                shopId,
                posId,
                pointToItem,
                product:leanProduct([...currentCart]),
                payment:leanPaymentChannel([...paymentChannel]),
                posNumber, // เอาไว้ออกใบกำกับภาษี
                shiftId, // เอาไว้ track กะ
                cashierId,
                cashierName,
                currentCredit,
                lucky:manageFortune(campaign),
                gainPoint,
                usedPoint,
                existPoint,
                campaign,
                change,
                vatAmount, // vat แบบ include 7%
                vatType,
                rounding,
                note,
                receiptType
        };
        if(currentMember.id){
            finalReceipt.member = currentMember
        }
        let minusStockResult = []
        const countStock = currentCart.filter(a=>a.stockCountStatus)
        const countStockIds = new Set(countStock.map(a=>a.id));
        const newStock = []
        for(const { id, qty, linkMultiply, linkDetail } of countStock){
            if(linkMultiply){
                const totalQty = Number(qty) * Number(linkMultiply)
                linkDetail.forEach(a=>{
                    let findProduct = newStock.find(b=>b.id === a.id);
                    if(findProduct){
                        findProduct.qty += totalQty
                    } else {
                        newStock.push({
                            id:a.id,
                            qty:totalQty
                        })
                    }
                })
            } else {
                let findProduct = newStock.find(a=>a.id === id);
                if(findProduct){
                    findProduct.qty += Number(qty)
                } else {
                    newStock.push({
                        id,
                        qty:Number(qty)
                    })
                }
            }
        };

        const receiptGuardRef = db.collection('receiptGuard').doc(receiptUUID);
        const guardDoc = await receiptGuardRef.get();
        if (guardDoc.exists) return res.status(200).send({ message: 'already checkout' });

        const collectionName = receiptType === 'month' ? 'billId' : 'billDayId';
        const dateField = receiptType === 'month' ? 'month' : 'date';
        const currentDateValue = getCurrentDateInfo(receiptType);

           await db.runTransaction(async (transaction) => {
                let receiptNumber = getStringReceipt(receiptType, 1);
                let minusStockResult = [];
                let existPoint = '';
                const billIdRef = db.collection(collectionName).doc(id);
                const billIdDoc = await transaction.get(billIdRef);
                if (billIdDoc.exists) {
                    billInfo = billIdDoc.data()
                    const { [dateField]: storedDate, receipts } = billInfo;
                    if (storedDate === currentDateValue) {
                        receiptNumber = getStringReceipt(receiptType, receipts + 1);
                    }
                };
                    
                const guardRef = db.collection('receiptGuard').doc(receiptUUID);
                const newBillRef = db.collection('bill').doc();
                const memberRef = currentMember?.id ? db.collection('member').doc(currentMember.id) : null;

                // Preload all stock document refs
                const stockRefs = newStock.map(({ id }) => db.collection("stock").doc(id));
                const stockDocs = await Promise.all(stockRefs.map(ref => transaction.get(ref)));

                if (!billIdDoc.exists) {
                    transaction.set(billIdRef, { [dateField]: currentDateValue, receipts: 1 });
                } else {
                    const { [dateField]: storedDate, receipts } = billInfo;
                    if (storedDate === currentDateValue) {
                    transaction.update(billIdRef, { receipts: receipts + 1 });
                    } else {
                    transaction.update(billIdRef, { receipts: 1, [dateField]: currentDateValue });
                    }
                };

                 for (let i = 0; i < newStock.length; i++) {
                    const { id, qty: qty2 } = newStock[i];
                    const stockDoc = stockDocs[i];
            
                    if (!stockDoc.exists) throw new Error(`Product ${id} not found`);
            
                    const { stock, name, unit, safetyStock = {} } = stockDoc.data();
                    const { status = false, qty = 0 } = safetyStock;
            
                    const stockPrev = Number(nanToZero(stock));
                    const stockNext = stockPrev - Number(qty2);
            
                    const updateFields = {
                        stock: stockNext,
                        updateTime: admin.firestore.FieldValue.serverTimestamp()
                    };
            
                    if (countStockIds.has(id)) {
                        updateFields.latestSaleDate = admin.firestore.FieldValue.serverTimestamp()
                    }
            
                    transaction.update(stockRefs[i], updateFields);
            
                    minusStockResult.push({
                        stockPrev, stockNext, name, unit, status, qty: Number(qty),
                    });
                }
                

                if (memberRef) {
                    const memberDoc = await transaction.get(memberRef);
                    if (!memberDoc.exists) throw new Error("Member not found");
            
                    const {
                        point = 0,
                        bought = [],
                        creditArray = [],
                    } = memberDoc.data();
            
                    const thisYearMonth = yearMonth(new Date());
                    const existing = bought.find(a => a.yearMonth === thisYearMonth);
                    const newBought = [...bought];
            
                    if (existing) {
                        existing.buy += moneyMustPaid;
                        existing.time += 1;
                    } else {
                        newBought.push({
                        yearMonth: thisYearMonth,
                        buy: moneyMustPaid,
                        time: 1,
                        year: stringY(new Date())
                        });
                    }
            
                    const newPoint = point + Number(diffPoint);
                    existPoint = newPoint;
            
                    const memberObj = {
                        point: newPoint,
                        bought: newBought,
                        lastTime: new Date(),
                    };
            
                    const numberCredit = Number(currentCredit);
                    if (numberCredit > 0) {
                        memberObj.creditArray = [
                        ...creditArray,
                        {
                            receiptNumber,
                            billId: newBillRef.id,
                            totalCredit: numberCredit,
                            remainCredit: numberCredit,
                            timestamp: new Date(),
                        }
                        ];
                    }
            
                    transaction.update(memberRef, memberObj);
                }

                // 4. Add receipt to bill
                transaction.set(newBillRef, {
                    ...finalReceipt, 
                    receiptNumber,
                    existPoint,
                });

                // 5.guardRef
                transaction.set(guardRef,{
                    createdAt: new Date(),
                    usedBy: receiptNumber ,
                    shopId:id
                })

            });
    try{
        res.status(200).send('hello world');
    }catch(err){
        functions.logger.error("function:checkPhoneRegister:error",err)
        res.status(500).send({ message:"Internal Server Error",error:err})
    }
});









module.exports = app;
