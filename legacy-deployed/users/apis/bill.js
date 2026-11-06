const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch-commonjs");   // config adjust of "node-fetch" ,for compatible with all javascript,ESM,node version
const axios = require("axios");
const env = require("../env.json");

const app = express();
app.use(cors({origin:true}));

const { checkSharedDataGrantUser, validateAndRefeshAuthToken, checkIfAuthenticated } = require("../middlewares/auth_middleware");
const { findInArray, summary, formatTime } = require("../helpers/functions");
const { minusDays, NumberYMD } = require("../helpers/dateTime");


var db = admin.firestore(); // Initialize Firestore database
// checkPhoneRegister
app.post("/test", async (req, res) => {
    try {
        const { shopId, lastDoc, limit, startDate, endDate } = req.body;
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
            return res.status(200).send({ newData: [], newLastDoc: null });
        }

        let newData = snapshot.docs.map(doc => ({
            id: doc.id,
            void:false,
            ...doc.data(),
            dateTime:doc.data().dateTime.toDate()
        }));

        let newLastDoc = snapshot.docs[snapshot.docs.length - 1];

        newData = newData.map(a=>({...a,voidStatus:a.void}));

        res.status(200).send({
            newData,
            newLastDoc: newLastDoc ? { id: newLastDoc.id } : null
        });

    } catch (err) {
        console.error("Pagination Error:", err);
        res.status(500).send({ message: "Internal Server Error", error: err });
    }
});

app.post("/summary", async (req, res) => {
    try{
  
        const { shopId, startDate, endDate } = req.body;
  
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
        const average = qty>0?totalSale/qty:0;
          
        res.status(200).send({ qty, totalSale:totalSale.toLocaleString(undefined, {minimumFractionDigits: 2,maximumFractionDigits: 2}), average:average.toLocaleString(undefined, {minimumFractionDigits: 2,maximumFractionDigits: 2}) });
    }catch(err){
        res.status(500).send(err)
    }
  });

app.post("/loading", async (req, res) => {
    const { profileId, uniqueId } = req.body;
    let profileData = {}, navigate = 'WelcomeScreen', shopData = {}, memberData = {}, adminConfig = {}, updateVersionData = {};
    let newCurrentLogin = { shopId: '', printer: [], rights: [] };
    let newPort = [], shopId = '';

    try {
        // Fetch data in parallel
        const [updateDoc, configDoc, profileDoc] = await Promise.all([
            db.collection("admin").doc('updateScanfood').get(),
            db.collection('admin').doc('adminConfig').get(),
            db.collection("profile").doc(profileId).get()
        ]);

        updateVersionData = updateDoc.data();
        adminConfig = configDoc.data();
        if (!profileDoc.exists) throw new Error("Profile not found");

        const { dateTime, birthday, currentLogin, port, ...rest } = profileDoc.data();
        profileData = {
            ...rest, currentLogin, port,
            dateTime: dateTime.toDate(),
            id: profileDoc.id,
            birthday: birthday ? birthday.toDate() : new Date(),
            uniqueId
        };

        if (currentLogin?.shopId) {
            shopId = currentLogin.shopId;
            const shopRef = db.collection('shop').doc(shopId);

            // Fetch shop and provider in parallel if needed
            const shopDoc = await shopRef.get();
            if (!shopDoc.exists) throw new Error("Shop not found");

            const { humanResource, name, vip, providerId } = shopDoc.data();
            shopData = { ...shopDoc.data(), id: shopId };

            if (providerId) {
                const memberRef = db.collection('memberProvider').doc(providerId);
                const memberDoc = await memberRef.get();
                if (memberDoc.exists) {
                    const { coupon, ...rest } = memberDoc.data();
                    memberData = {
                        ...rest,
                        id: memberRef.id,
                        coupon: coupon.map(a => ({
                            ...a, startDate: formatTime(a.startDate), endDate: formatTime(a.endDate)
                        }))
                    };
                }
            }

            // Optimize humanResource lookup
            let newHumanResource = humanResource.map((item, index) => index === 0 ? item : { ...item, status: 'inActive' });

            let findStaff = vip?.find(a => a.type === 'staff');
            if (findStaff && NumberYMD(new Date()) <= NumberYMD(findStaff.expire.toDate())) {
                newHumanResource = humanResource;
            }

            let stillHaveRight = newHumanResource.find(a => a.id === profileId && a.status === 'active');
            if (stillHaveRight) {
                let fPort = findInArray(port, 'shopId', shopId);
                newCurrentLogin = {
                    shopId, printer: fPort.printer, rights: stillHaveRight?.rights || []
                };

                let updatePort = {
                    ...fPort, shopName: name, position: stillHaveRight.position, lastLogin: new Date()
                };

                newPort = port.map(a => a.shopId === shopId ? updatePort : a);
                navigate = 'HomeScreen';

                // Update within a transaction
                await db.runTransaction(async (transaction) => {
                    transaction.update(profileDoc.ref, { currentLogin: newCurrentLogin, port: newPort });
                });
            }
        }

        console.log("All operations completed successfully!");
        res.status(200).send({ shopData, shopId, newCurrentLogin, newPort, updateVersionData, profileData, memberData, navigate, adminConfig });
    } catch (error) {
        console.error("Operation failed:", error);
        res.status(500).send({ message: "Operation failed: " + error.message });
    }
});

app.post("/select", async (req, res) => {
    try {
        const { shopId } = req.body;
        let query = db.collection('checkout')
            .where("shopId", "==", shopId)
            // .select('net')
            .limit(30);


        const snapshot = await query.get();

        let newData = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
        }));
        console.log(newData)



        res.status(200).send(newData);

    } catch (err) {
        console.error("Pagination Error:", err);
        res.status(500).send({ message: "Internal Server Error", error: err });
    }
});


module.exports = app;
