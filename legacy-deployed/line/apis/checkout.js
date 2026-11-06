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
                    updateTime: firebase.firestore.FieldValue.serverTimestamp()
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

app.post("/pack", async (req, res) => {
 
    try{
        res.status(200).send('hello world');
    }catch(err){
        functions.logger.error("function:checkPhoneRegister:error",err)
        res.status(500).send({ message:"Internal Server Error",error:err})
    }
});









module.exports = app;
