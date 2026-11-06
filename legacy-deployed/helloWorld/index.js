const functions = require("firebase-functions");
const requestFunction = functions.region("asia-southeast2").https;

// const cors = require("cors");
// const app = express();
// app.use(cors({ origin: true }))




const admin = require("firebase-admin");

// const serviceAccount = require("/Users/pawinsanvongsiri/desktop/secretKey/shopcham-24b0b-firebase-adminsdk-m2c3j-862a1de315.json")
const serviceAccount = require("./shopcham-24b0b-firebase-adminsdk-m2c3j-862a1de315.json")



admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
    // databaseURL:""   // for "Realtime Database",not necessry if not use it ,can find the URL when start its in firebase console
});


// api
const functionUsers = require("./apis/users");
const functionOneSignal = require("./apis/onesignal");

exports.helloWorld = requestFunction.onRequest((req, res) =>{
    functions.logger.info("deploy 5",{structureData:true});
    res.send("deploy 5");
});


/* exports.checkPhoneRegister = requestFunction.onRequest( async (req,res)=>{
    // exports.checkPhoneRegister = requestFunction.onCall()
    try{
        // const { phoneNumber } = req.params

        // // let userPhoneRegister = await admin.auth().getUserByPhoneNumber("+66856103603");
        // let userPhoneRegister = await admin.auth().getUserByPhoneNumber(phoneNumber);
        // functions.logger.info("function:getPhoneRegister:info", { message: "getUserByPhoneNumber success" });
        // // res.send(phoneNumber);
        // res.send(userPhoneRegister);

        const { phoneNumber } = req.params;
        res.send(phoneNumber);

    }catch(err){
        functions.logger.error("function:getPhoneRegister:error",{error:err})
    }
}); */




// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

/* const auth = admin.auth();
const db = admin.firestore();
const storage = admin.storage();

// global.auth = auth;
// global.db = db;
// global.storage = storage; */


// api handlers
exports.users = requestFunction.onRequest(functionUsers);
exports.onesignal = requestFunction.onRequest(functionOneSignal);