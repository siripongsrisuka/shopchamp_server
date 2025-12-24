const functions = require("firebase-functions");
const admin = require("firebase-admin");
const requestFunction = functions.region("asia-southeast2").https;

const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors({ origin: true }))


const axios = require('axios');
const https = require('https');



// const serviceAccount = require("/Users/pawinsanvongsiri/desktop/secretKey/shopcham-24b0b-firebase-adminsdk-m2c3j-862a1de315.json")
const serviceAccount = require("./shopcham-24b0b-firebase-adminsdk-m2c3j-862a1de315.json")


admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    // databaseURL:""   // for "Realtime Database",not necessry if not use it ,can find the URL when start its in firebase console
    storageBucket:"shopcham-24b0b.appspot.com",
});


// api
const functionUsers = require("./apis/users");
const functionAdmin = require("./apis/admin");
const functionOneSignal = require("./apis/onesignal");
const functionEscPos = require("./apis/escpos");
const functionGroupBuying = require("./apis/groupBuying");
const functionSharedData = require("./apis/sharedData");
const functionCheckout = require("./apis/checkout");
const functionShift = require("./apis/shift");
const functionLine = require("./apis/line");
const functionBill = require("./apis/bill");
const functionMember = require("./apis/member");
const functionPaymentGateway = require("./apis/paymentGateway");
const functionKshop = require("./apis/kshop");
const functionShop= require("./apis/shop");


exports.helloWorld = requestFunction.onRequest((req, res) =>{
    functions.logger.info("deploy 5",{structureData:true});
    res.send("deploy 5");
});



// api handlers
exports.users = requestFunction.onRequest(functionUsers);
exports.admin = requestFunction.onRequest(functionAdmin);
exports.onesignal = requestFunction.onRequest(functionOneSignal);
exports.escpos = requestFunction.onRequest(functionEscPos);
exports.groupBuying = requestFunction.onRequest(functionGroupBuying);
exports.sharedData = requestFunction.onRequest(functionSharedData);
exports.checkout = requestFunction.onRequest(functionCheckout);
exports.shift = requestFunction.onRequest(functionShift);
exports.line = requestFunction.onRequest(functionLine);
exports.bill = requestFunction.onRequest(functionBill);
exports.member = requestFunction.onRequest(functionMember);
exports.paymentGateway = requestFunction.onRequest(functionPaymentGateway);
exports.kshop = requestFunction.onRequest(functionKshop);
exports.shop = functions
  .region("asia-southeast2")
  .runWith({ timeoutSeconds: 300, memory: "1GB" }) // Increase timeout and memory
  .https.onRequest(functionShop)








exports.delDeleteSkuStock = functions.pubsub.schedule('0 3 1 * *').timeZone('Asia/Bangkok').onRun(async (context) => {
// exports.delDeleteSkuStock = functions.pubsub.schedule('* * * * *').timeZone('Asia/Bangkok').onRun(async (context) => {
// exports.delDeleteSkuStock = functions.pubsub.schedule('1-5 * * * *').timeZone('Asia/Bangkok').onRun(async (context) => {
    try{
        console.log("delDeleteSkuStock")

        const cronDateTime = new Date();
        await admin.firestore().collection("testCron").doc("firebaseSchedule").update({delDeleteSkuStock:cronDateTime});
        console.log("delDeleteSkuStock run task every 1 minute at : "+cronDateTime);

       await admin.firestore().collection('stock')
        .where('sku','==','delete')
        .get()
        .then(async qsnapshot =>{

            if(qsnapshot.docs.length > 0){
                for(const doc of qsnapshot.docs){

                    await admin.firestore().collection('stock').doc(doc.id).delete();
                }
            }

        })

        functions.logger.info("function:delDeleteSkuStock:info",{message:"Success Delete SKU Stock"});
        res.status(200).send({message:`Success Delete SKU Stock`});

    }catch(err){
        functions.logger.error("function:delDeleteSkuStock:catch",err);
    }
}); 
