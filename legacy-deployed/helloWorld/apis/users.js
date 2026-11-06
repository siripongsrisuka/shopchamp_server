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


//  checkClaim
app.get("/checkClaim/:checkBy/:checkValue", async (req, res) => {
    try{
        const {checkBy,checkValue} = req.params;

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
                functions.logger.error("function:checkClaim:cacth", "Invalid checkBy");
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
        functions.logger.error("function:checkClaim:catch",err);
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


app.delete("/clearAppReg/:uid", async (req,res) => {
    try{
        const {uid} = req.params;
        const user = await admin.auth().getUser(uid);
        if(user){
            // // clear demo test
            await admin.auth().setCustomUserClaims(user.uid,{});
            return res.status(200).send({message:`Clear CustomClaims of ${uid}`});
        }else{
            functions.logger.error("function:clearAppReg:cacth", "Invalid User");
            return res.status(500).send({message:"auth/invalid-user"});
        }
    }catch(err){
        functions.logger.error("function:clearAppReg:error",err);
        res.status(500).send({ message: "Internal Server Error",error:err});
    }
});


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


// //  putAllMerchantAppReg
app.post("/putAllMerchantAppReg", async (req,res) => {
    try{
        let allUsers = [];
        const appName = "merchant";

        const listAllUsers = async (nextPageToken) => {
            // List batch of users, limit maximum 1000 at a time. So,if want all user => loop it's own function like this until empty "nextPageToken"
            await admin.auth()
                .listUsers(1000, nextPageToken)
              .then( async res => {
                await res.users.forEach(async (user,i) => {
                  console.log('user', user.toJSON());
                //   allUsers.push(user.uid);


                    // if(  // App been registered
                    // ![undefined,-1].includes(user?.customClaims?.appReg?.findIndex( ({appName:hisRegApp}) => hisRegApp === appName) )  // undefined = not have customClaims,appReg object, -1 = have the obj but not found key value
                    // ){
                    //     // functions.logger.error("function:setAppReg:catch","auth/duplicate-register-app");
                    //     // return res.status(500).send({message:"auth/duplicate-register-app"});
                    // }else{
                    //     if(user?.customClaims?.appReg?.length > 0){ // Used registed at least one app
                    //         await admin.auth().setCustomUserClaims(user.uid,{
                    //             ...user.customClaims,
                    //             appReg:[...user?.customClaims?.appReg,{appName:appName}]
                    //         });
                    //     }else{  // First time to register the app
                    //         await admin.auth().setCustomUserClaims(user.uid,{
                    //             ...user?.customClaims,
                    //             appReg:[{appName:appName}]
                    //         });
                    //     }
                    // }

                });

                if (res.pageToken) {
                  // List next batch of users.
                  await listAllUsers(res.pageToken); // !! must set "await" to make synchonous after the first execution of this function.Otherwise,it will return response value only first round ,the rest round run but not send a rest value to array
                }
              })
                .catch((error) => {
                    console.log("Error listing users:", error);
                });
          };
          // function with do it self function again until thougth out all user
          await listAllUsers();

          console.log(allUsers.length)
          console.log(allUsers)


        //   await allUsers.forEach(async uid=>{
        //     await fetch(`${scEndPoint}/users/setAppReg`,{
        //         method: 'POST',
        //         headers: {
        //         'Content-Type': 'application/json'
        //         },
        //         body: JSON.stringify({
        //             uid:uid,
        //             appName:"merchant"
        //         })
        //     })
            
        //   });

          functions.logger.info("function:putAllMerchantAppReg:info",{message:`Set all users with merhcant appReg complete !`});
          res.status(200).send({message:`Set all users with merhcant appReg complete !`});
    }catch(err){
        functions.logger.error("function:putAllMerchantAppReg:error",err);
        res.status(500).send({ message: "Internal Server Error",error:err});
    }

});


module.exports = app;
