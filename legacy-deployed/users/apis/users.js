const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch-commonjs");   // config adjust of "node-fetch" ,for compatible with all javascript,ESM,node version

const app = express();
app.use(cors({origin:true}));



// https://asia-southeast2-shopcham-24b0b.cloudfunctions.net/users/checkPhoneRegister/+668531882

const scEndPoint = "https://asia-southeast2-shopcham-24b0b.cloudfunctions.net";

// checkPhoneRegister
app.get("/checkPhoneRegister/:phoneNumber", async (req, res) => {
    try{
        const {phoneNumber} = req.params;
        // let userPhoneRegister = await admin.auth().getUserByPhoneNumber("+66856103603");
        let userPhoneRegister = await admin.auth().getUserByPhoneNumber(phoneNumber);
        functions.logger.info("function:checkPhoneRegister:info",{message:"Found Registered User"});
        res.status(200).send(userPhoneRegister);
    }catch(err){
        functions.logger.error("function:checkPhoneRegister:error",err)
        res.status(500).send({phoneNumber:req.params.phoneNumber, message:"Internal Server Error",error:err})
    }
});

app.post("/scan", async (req, res) => {
    const { uid } = req.body;
    try{
        const frbUserCustomToken = await admin.auth().createCustomToken(uid);

        functions.logger.info("function:scan:info",{message:"Found Registered User"});
        res.status(200).send({ frbUserCustomToken });
    }catch(err){
        functions.logger.error("function:scan:error",err)
        res.status(500).send({message:"Internal Server Error",error:err})
    }
});

app.post("/createDoc", async (req, res) => {
    try{
        const scanRef = admin.firestore().collection("loginByScan").doc();
        await scanRef.set({ uid: "", docId:scanRef.id, timestamp:new Date() });

        res.status(200).send({ docId:scanRef.id });
    }catch(err){
        functions.logger.error("function:scan:error",err)
        res.status(500).send({message:"Internal Server Error",error:err})
    }
});





//  checkClaim
app.get("/checkClaim/:checkBy/:checkValue", async (req, res) => {
    const {checkBy,checkValue} = req.params;

    try{
        // const {checkBy,checkValue} = req.params;

        // functions.logger.info("function:checkClaim:info",{...req.params});
        //     return res.status(200).send({...req.params});
        
        let user = null;
        switch(checkBy){
            case 'uid':
                user = await admin.auth().getUser(checkValue);
                break;
            case 'email':
                user = await admin.auth().getUserByEmail(checkValue);
                break;
            case 'phoneNumber':
                user = await admin.auth().getUserByPhoneNumber(checkValue);
                break;
            // case 'providerUid':
            //     user = await admin.auth().getUserByProviderUid()
            //     break;
            default:
                functions.logger.error("function:checkClaim:catch", "Invalid checkBy");
                return res.status(500).send({message:"auth/invalid-check-by"});
        }

        if(user){
            functions.logger.info("function:checkClaim:info",{message:"Found User Claim"});
            return res.status(200).send(user.customClaims);
        }else{
            functions.logger.error("function:checkClaim:catch", "Invalid User");
            return res.status(500).send({message:"auth/invalid-user"});
        }

    }catch(err){
        // functions.logger.error("function:checkClaim:catch",err);
        // functions.logger.error(`function:checkClaim:catch:checkValue:${checkValue}`,err);
        functions.logger.error(`function:checkClaim:catch:checkBy:${checkBy}:checkValue:${checkValue}`,err);

        res.status(500).send({ message: "Internal Server Error",error:err});
    }
});

app.post("/email", async (req, res) => {
    const { email } = req.body;

    try{
        
        let user = await admin.auth().getUserByEmail(email);

        if(user){
            functions.logger.info("function:checkClaim:info",{message:"Found User Claim"});
            return res.status(200).send(user);
        }else{
            functions.logger.error("function:checkClaim:catch", "Invalid User");
            return res.status(500).send({message:"auth/invalid-user"});
        }

    }catch(err){
        functions.logger.error(`function:checkClaim`,err);

        res.status(500).send({ message: "Internal Server Error",error:err});
    }
});


/* // //  setAppReg
app.post("/setAppReg", async (req,res) => {
    try{
        const {uid,appReg} = req.body;
        const user = await admin.auth().getUser(uid);
        if(user){
            if(!["merchant", "vender"].includes(appReg)){
                functions.logger.error("function:setAppReg:catch","Invalid appReg");
                return res.status(500).send(`function:setAppReg:catch`, "Invalid appReg");
            }else{
                // await admin.auth().setCustomUserClaims(user.uid,{...user.customClaims,appReg:appReg});
                const objClm = await admin.auth().setCustomUserClaims(user.uid,{});
                functions.logger.info("function:setAppReg:info",{message:`User Register ${appReg}`});
                res.status(200).send({message:`User Register ${appReg}`});
            }
        }else{
            functions.logger.error("function:setAppReg:catch", "Invalid User");
            return res.status(500).send({message:"auth/invalid-user"});
        }
    }catch(err){
        functions.logger.error("function:setAppReg:catch",err);
        response.status(500).send({ message: "Internal Server Error" });
    }
}); */





// //  setAppReg
app.post("/setAppReg", async (req,res) => {
    try{
        const {uid,appName} = req.body;

        console.log('uid:',uid,'appName:',appName)

        const user = await admin.auth().getUser(uid);

        if(user){ // Incorrect app name
            if(!["merchant", "vender"].includes(appName)){
                functions.logger.error("function:setAppReg:catch","Invalid appName");
                return res.status(500).send({message:"auth/invalid-app-name"});
            }else if(  // App been registered
                ![undefined,-1].includes(user?.customClaims?.appReg?.findIndex( ({appName:hisRegApp}) => hisRegApp === appName) )  // undefined = not have customClaims,appReg object, -1 = have the obj but not found key value
            ){
                // functions.logger.error("function:setAppReg:catch","auth/duplicate-register-app");
                // return res.status(500).send({message:"auth/duplicate-register-app"});
            }else{
                if(user?.customClaims?.appReg?.length > 0){ // Used registed at least one app
                    await admin.auth().setCustomUserClaims(user.uid,{
                        ...user.customClaims,
                        appReg:[...user?.customClaims?.appReg,{appName:appName}]
                    });
                }else{  // First time to register the app
                    await admin.auth().setCustomUserClaims(user.uid,{
                        ...user?.customClaims,
                        appReg:[{appName:appName}]
                    });
                }

                functions.logger.info("function:setAppReg:info",{message:`User Register ${appName}`});
                res.status(200).send({message:`User Register ${appName}`});
            }
        }else{ // Not Found user in firebasae authen
            functions.logger.error("function:setAppReg:cacth", "Invalid User");
            return res.status(500).send({message:"auth/invalid-user"});
        }
    }catch(err){
        functions.logger.error("function:setAppReg:error",err);
        res.status(500).send({ message: "Internal Server Error",error:err});
    }
});



// //  signInToGetAuthToken
// app.post("/signInToGetAuthToken/:authBy", async (req, res) => {
    
//     try{
//         const { authBy } = req.params;
//         const { email,password } = req.body;


//         let user = null;
//         let apiReq = null;
//         switch(authBy){
//             case 'email':
//                 user = await admin.auth().getUserByEmail(email);
//                 apiReq = {
//                     method: 'POST',
//                     url: `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.Web_API_Key}`,
//                     headers: {
//                         'content-type': 'application/json',
//                     },
//                     data: { // ("body")
//                         email:email,
//                         password:password,
//                         returnSecureToken:true,
//                     }
//                 };
//                 break;
//             default:
//                 functions.logger.error("function:signInToGetAuthToken:cacth", "Invalid authBy");
//                 return res.status(400).send({message:"auth/invalid-authBy"});
//         }

//         if(!user?.uid){
//             functions.logger.error("function:signInToGetAuthToken:cacth", "Invalid user");
//             return res.status(400).send({message:"auth/invalid-user"});
//         }
        
//         const response = await axios.request(apiReq);
//         res.status(response.status).json(response.data);

//         if (response.status === 200){
//             functions.logger.info("function:signInToGetAuthToken:info",{message:"success signInToGetAuthToken"});
//             res.status(response.status).json(response.data);
//         }else {
//             functions.logger.error("function:signInToGetAuthToken:error",response);
//             res.status(response.status).json(response.data);
//         }

//         // {
//         //     "localId": "ZY1rJK0eYLg...",
//         //     "email": "[user@example.com]",
//         //     "displayName": "",
//         //     "idToken": "[ID_TOKEN]",
//         //     "registered": true,
//         //     "refreshToken": "[REFRESH_TOKEN]",
//         //     "expiresIn": "3600"
//         //   }


//     }catch(err){
//         functions.logger.error("function:signInToGetAuthToken:catch",err);
//         res.status(500).send({ message: "Internal Server Error",error:err});
//     }
// });




// //  refreshAuthToken
// app.post("/refreshAuthToken",validateAndRefeshAuthToken ,async (req, res) => {
//     try{
//         const { status,data } = req.body;


//         if (status === 200){
//             functions.logger.info("function:signInToGetAuthToken:info",{message:"success refreshAuthToken"});
//             res.status(status).json(data);
//         }else {
//             functions.logger.error("function:signInToGetAuthToken:error",response);
//             res.status(status).json(data);
//         }

//         // {
//         //     "localId": "ZY1rJK0eYLg...",
//         //     "email": "[user@example.com]",
//         //     "displayName": "",
//         //     "idToken": "[ID_TOKEN]",
//         //     "registered": true,
//         //     "refreshToken": "[REFRESH_TOKEN]",
//         //     "expiresIn": "3600"
//         //   }


//     }catch(err){
//         functions.logger.error("function:refreshAuthToken:catch",err);
//         res.status(500).send({ message: "Internal Server Error",error:err});
//     }
// });





// //  resetPartnerPwdInEmail
// app.post("/resetPartnerPwdInEmail", async (req, res) => {
//     try{
//         const { email } = req.body;

//         const user = await admin.auth().getUserByEmail(email);

//         if(!user?.uid){
//             functions.logger.error("function:signInToGetAuthToken:cacth", "Invalid user");
//             return res.status(400).send({message:"auth/invalid-user"});
//         }

//         const apiReq = {
//             method: 'POST',
//             url: `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${env.Web_API_Key}`,
//             headers: {
//                 'content-type': 'application/json',
//             },
//             data: { // ("body")
//                 requestType:"PASSWORD_RESET",
//                 email:email,
//             }
//         };
        
//         const response = await axios.request(apiReq);
//         res.status(response.status).json(response.data);

//         if (response.status === 200){
//             functions.logger.info("function:resetPartnerPwdInEmail:info",{message:"success resetPartnerPwdInEmail"});
//             res.status(response.status).json(response.data);
//         }else {
//             functions.logger.error("function:resetPartnerPwdInEmail:error",response);
//             res.status(response.status).json(response.data);
//         }


//     }catch(err){
//         functions.logger.error("function:resetPartnerPwdInEmail:catch",err);
//         res.status(500).send({ message: "Internal Server Error",error:err});
//     }
// });

app.post("/register", async (req, res) => {

    let obj = {
        android:false,
        ios:false
    }
    try {
        const updateDoc = await admin.firestore().collection('admin').doc('updateShopchamp').get();
        if(updateDoc.exists){
            const { android, ios } = updateDoc.data();
            obj = {
                android:android.isPackageOn,
                ios:ios.isPackageOn,
            }
        };
        

        console.log("All operations completed successfully!");
        res.status(200).send(obj);
    } catch (error) {
        console.error("Batch update failed:", error);
        res.status(500).send({ message: "Batch update failed: " + error.message });
    }
});



module.exports = app;
