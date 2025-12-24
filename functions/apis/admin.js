const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors({origin:true}));


// //  setAdmin
app.post("/setAdmin/:setBy/:setValue", async (req,res) => {
    try{
        const {setBy,setValue} = req.params;

        let user = null;
        switch(setBy){
            case 'uid':
                user = await admin.auth().getUser(setValue);
                break;
            case 'email':
                user = await admin.auth().getUserByEmail(setValue);
                break;
            case 'phoneNumber':
                user = await admin.auth().getUserByPhoneNumber(setValue);
                break;
            // case 'providerUid':
            //     user = await admin.auth().getUserByProviderUid()
            //     break;
            default:
                functions.logger.error("function:setAdmin:cacth", "Invalid setBy");
                return res.status(500).send({message:"auth/invalid-set-by"});
        }

        if(user){
            await admin.auth().setCustomUserClaims(user.uid,{
                ...user.customClaims,
                isAdmin:true
            });
            functions.logger.info("function:setAdmin:info",{message:`User Register to Admin`});
            res.status(200).send({message:`User Register to Admin`});
            
        }else{ // Not Found user in firebasae authen
            functions.logger.error("function:setAdmin:cacth", "Invalid User");
            return res.status(500).send({message:"auth/invalid-user"});
        }
    }catch(err){
        functions.logger.error("function:setAdmin:error",err);
        res.status(500).send({ message: "Internal Server Error",error:err});
    }
});


// //  revokeRefreshToken (use as stop user login status for device lost and let user login again)
app.post("/revokeRefreshToken/:setBy/:setValue", async (req,res) => {
    try{
        const {setBy,setValue} = req.params;

        let user = null;
        switch(setBy){
            case 'uid':
                user = await admin.auth().getUser(setValue);
                break;
            case 'email':
                user = await admin.auth().getUserByEmail(setValue);
                break;
            case 'phoneNumber':
                user = await admin.auth().getUserByPhoneNumber(setValue);
                break;
            // case 'providerUid':
            //     user = await admin.auth().getUserByProviderUid()
            //     break;
            default:
                functions.logger.error("function:revokeRefreshToken:cacth", "Invalid setBy");
                return res.status(500).send({message:"auth/invalid-set-by"});
        }



        if(user){
            await admin.auth().revokeRefreshTokens(user.uid)
                .then(() => {
                    return admin.auth().getUser(user.uid);
                })
                .then((userRecord) => {
                    return new Date(userRecord.tokensValidAfterTime).getTime() / 1000;
                })
                .then((timestamp) => {
                    console.log(`Tokens revoked at: ${timestamp}`);
                    functions.logger.info("function:revokeRefreshToken:info",{message:`Tokens revoked at: ${timestamp}`});
                    res.status(200).send({message:`Tokens revoked at: ${timestamp}`});
                });
            
            
        }else{ // Not Found user in firebasae authen
            functions.logger.error("function:revokeRefreshToken:cacth", "Invalid User");
            return res.status(500).send({message:"auth/invalid-user"});
        }
    }catch(err){
        functions.logger.error("function:revokeRefreshToken:error",err);
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


// app.post("/delDeleteSkuStock",async (req,res) => {
//     try{
//         console.log("delDeleteSkuStock")

//         const cronDateTime = new Date();
//         await admin.firestore().collection("testCron").doc("firebaseSchedule").update({delDeleteSkuStock:cronDateTime});
//         console.log("delDeleteSkuStock run task every 1 minute at : "+cronDateTime);

//        await admin.firestore().collection('stock')
//         .where('sku','==','delete')
//         .get()
//         .then(async qsnapshot =>{

//             if(qsnapshot.docs.length > 0){
//                 for(const doc of qsnapshot.docs){

//                     await admin.firestore().collection('stock').doc(doc.id).delete();
//                 }
//             }



//         })

//         functions.logger.info("function:delDeleteSkuStock:info",{message:"Success Delete SKU Stock"});
//         res.status(200).send({message:`Success Delete SKU Stock`});


//     }catch(err){
//         functions.logger.error("function:delDeleteSkuStock:catch",err);
//     }
// });


// //  assignEmailAuthenToUser
app.post("/assignEmailAuthenToUser", async (req,res) => {
    try{
        const { existsAuthenType, existsAuthenId ,email, password, isRemoveEmailAuthen = false } = req.body;

        let user = null;
        switch(existsAuthenType){
            case 'uid':
                user = await admin.auth().getUser(existsAuthenId);
                break;
            case 'email':
                user = await admin.auth().getUserByEmail(existsAuthenId);
                break;
            case 'phoneNumber':
                user = await admin.auth().getUserByPhoneNumber(existsAuthenId);
                break;
            // case 'providerUid':
            //     user = await admin.auth().getUserByProviderUid()
            //     break;
            default:
                functions.logger.error("function:assignEmailAuthenToUser:cacth", "Invalid existsAuthenType");
                return res.status(500).send({message:"auth/invalid-exists-authen-type"});
        }

        if(user){

            // console.log('user_assignEmailAuthenToUser')
            // console.log(user)

            let userRecord = {};
            if(isRemoveEmailAuthen === true){
                // // // remove Email PasswordAuth
                userRecord = await admin.auth().updateUser(user.uid, {
                    providersToUnlink: ['password'],
                });                

            }else{

                // // Update the user with a new email/password
                userRecord = await admin.auth().updateUser(user.uid, {
                    email: email,
                    password: password,
                });
            }

            console.log('assignEmailAuthenToUser_userRecord');
            console.log(userRecord);

            if(isRemoveEmailAuthen === true){
                functions.logger.info("function:assignEmailAuthenToUser:info",{message:`Remove Email and Password Authen to User`});
                res.status(200).send({message:`Remove Email and Password Authen to User`});  
            }else{
                functions.logger.info("function:assignEmailAuthenToUser:info",{message:`Add Email and Password Authen to User`});
                res.status(200).send({message:`Add Email and Password Authen to User`});                
            }

        }else{ // Not Found user in firebasae authen
            functions.logger.error("function:assignEmailAuthenToUser:cacth", "Invalid User");
            return res.status(500).send({message:"auth/invalid-user"});
        }
    }catch(err){
        functions.logger.error("function:assignEmailAuthenToUser:error",err);
        res.status(500).send({ message: "Internal Server Error",error:err});
    }
});


module.exports = app;
