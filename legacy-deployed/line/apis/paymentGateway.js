const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fetch = require("node-fetch-commonjs");   // config adjust of "node-fetch" ,for compatible with all javascript,ESM,node version, fetch require for production to cloudfunciton it not like local server It not know the basic commnad "fetch()"

const app = express();
app.use(cors({origin:true}));

const env = require("../env.json");


const morrisPaymentTestAPI = "http://api-morris.natachat.com/service/v1";
const morrisPaymentAPI = "https://api.morrispayment.com/service/v1";
const paymentWebhookUrl = env.paymentWebhookUrl;   // /// get morris payment response when transaction success


const db = admin.firestore()


app.post("/pgWebhook",async (req,res)=>{

    functions.logger.info("function:webhook:info",{message:"recieved_webhook"});
    console.log("recieved_webhook")
  
    const { 
        chargeId = '',
        status = '',
        referenceId = '',
     } = req.body;
  
  
    try{
  
      if(status ==='SUCCEEDED'){
     
        db.collection('pgWebhook').doc(referenceId).update({ process:'success', chargeId})
        console.log("add_pgWebhook_to_firebase")
  
        functions.logger.info("function:pgWebhook:info",{message:"Success_pgWebhook"});
        return res.status(200).send({success:true,data:'success'});
  
      }else{
        functions.logger.info("function:pgWebhook:info",{message:"Not_has_basic_field"});
        console.log("Not_has_basic_field")
        return res.status(200).send({success:false,data:{message:"Not_has_basic_field"}});
      }
  
      
    }catch(err){
  
      return res.status(500).send({ 
        message: "Internal Server Error",
        error:err,
      });
  
    }
  
  });


// // payTransaction
// app.post("/payTransaction",checkIfAuthenticated, async (req,res)=>{
app.post("/payTransaction", async (req,res)=>{ // เอาไว้สร้างต้นขั้ว Qrcode
    const { 
        token,
        amount,
        reference_no,
        id:providerId,
        ...rest
     } = req.body;
     switch (providerId) {
        case 'morris':
            morrisProvider({ token, reference_no, amount, res })
            break;
        case 'member':
            memberProvider({ token, reference_no, amount, res })
            break;
     
        default:
            break;
     }
     
  
});

function objectToQRCodeString(obj) {
    try {
        // Convert the object to a JSON string
        const jsonString = JSON.stringify(obj);

        // You can use this string with a QR code generator
        return jsonString;
    } catch (error) {
        console.error("Failed to convert object to string:", error);
        return null;
    }
}



async function memberProvider({ reference_no, amount, res }){
  
    try{
        const responsePayment = objectToQRCodeString({ reference_no, amount })
        res.status(200).send({success:true,data:{qr_code_text:responsePayment}});
      
    }catch(err){

      console.log('catch_catch')
  
      return res.status(500).send({ 
        message: "Internal Server Error",
        error:err,
      });
  
    }
}

app.post("/createCharge",async (req,res)=>{

  const { 
    paymentMethodType = "QR_PROMPT_PAY",
    amount = 100,
    referenceId='scanfood',
    token
  } = req.body;
    const net = amount * 100; // หน่วยมันเป็นสตางค์
    try{
  
        let data = JSON.stringify({
          "amount": net,
          "currency": "THB",
          "paymentMethod": {
            "alipay": {},
            "card": {
              "cardHolderName": "CARDHOLDER NAME",
              "expiryMonth": 12,
              "expiryYear": 30,
              "pan": "4111111111111111",
              "securityCode": "123"
            },
            "cardInstallments": {
              "cardHolderName": "CARDHOLDER NAME",
              "expiryMonth": 12,
              "expiryYear": 30,
              "installmentPeriod": 10,
              "pan": "4111111111111111",
              "securityCode": "123"
            },
            "cardToken": {
              "cardTokenId": "string",
              "securityCode": "123"
            },
            "cardTokenInstallments": {
              "cardTokenId": "string",
              "installmentPeriod": 10,
              "securityCode": "123"
            },
            "linePay": {},
            "paymentMethodType":paymentMethodType ,
            "qrPromptPay": {
              "expiresAt": "2019-08-24T14:15:22Z"
            },
            "shopeePay": {},
            "trueMoney": {},
            "weChatPay": {}
          },
          "referenceId": referenceId,
          "returnUrl": "https://www.beamcheckout.com"
        });
        
        let config = {
          method: 'post',
          maxBodyLength: Infinity,
          url: 'https://api.beamcheckout.com/api/v1/charges',
          headers: { 
            'Content-Type': 'application/json', 
            
            'Authorization': 'Basic ' + token
          },
          data : data
        };
        
        const response = await axios.request(config)

        if(response.status===201){

            functions.logger.info("function:payTransaction:info",{message:"Success_payTransaction"});
            return res.status(200).send({success:true,data:{ imageBase64Encoded:response.data.encodedImage.imageBase64Encoded} });
            
        } else {
            const { message } = response; 
            return res.status(500).send({ message }); 
        }
     
    }catch(err){
  
      return res.status(500).send({ 
        message: "Internal Server Error",
        error:err,
      });
  
    }
  
  });

async function morrisProvider({ token, reference_no, amount, res }){
    let morris_profile_token_shop = token;
     let paymentType = 'qr_code_text';
     let serverOption = '1'
  
    try{

        let homeRoute = '';
        let morris_profile_token = '';
        switch(serverOption){
            case '1':      // // server
                homeRoute = morrisPaymentAPI;
                morris_profile_token = morris_profile_token_shop ? morris_profile_token_shop : env?.morris_profile_token_shopchamp_production;
                break;
            case '2':      // // test
                homeRoute = morrisPaymentTestAPI;
                morris_profile_token = morris_profile_token_shop ? morris_profile_token_shop : env?.morris_profile_token_shopchamp_testServer;

                break;
            default:      // // server
                homeRoute = morrisPaymentAPI;
                morris_profile_token = morris_profile_token_shop ? morris_profile_token_shop : env?.morris_profile_token_shopchamp_production;

        }

        // console.log('mock_reference_no')
        // console.log(mock_reference_no)

        let apiReq = {};
        switch(paymentType){
            case 'qr_code':
                apiReq = {
                    method: 'POST',
                    url: `${homeRoute}/payment/qr_code`,
                    headers: {
                        Authorization: morris_profile_token,
                        // // // from demo
                        // 'content-type': 'application/json',
                        // accept: 'image/png',

                        // direcct ask provider
                        responseType: 'blob',
                    },
                    data: {
                        amount:"1",
                        reference_no,
                        background_url: "http://your-backend-api/payment/response",
                        detail: "detail",
                        customer_name: "customer_name",
                        customer_email: "morris@example.com",
                        customer_address: "customer_address",
                        customer_telephone: "0987654321",
                        merchant_defined1: "any"
                    },
                    // timeout: 5000,
                };
                break;
            case 'qr_code_text':

                apiReq = {
                    method: 'POST',
                    url: `${homeRoute}/payment/qr_code/text`,
                    headers: {
                        Authorization: morris_profile_token,
                        'content-type': 'application/json',
                        accept: 'application/json',
                    },
                    data: {
                        amount: amount,
                        reference_no,
                        background_url: paymentWebhookUrl,
                    },
                    // timeout: 5000,
                };
                break;
            case 'credit_card':
                apiReq = {
                    method: 'POST',
                    // url: `${homeRoute}/payment/credit_card`,
                    headers: {
                        Authorization: morris_profile_token,
                        'content-type': 'application/json',
                        accept: 'application/json',
                    },
                    data: {
                        card: {
                            number: "4535017710535741",
                            expiration_month: "05",
                            expiration_year: "28",
                            security_code: "184",
                            name: "name credit demo"
                        },
                        amount: 12.33,
                        // reference_no: "9d5AqjauCKxysLQG",
                        reference_no,
                        // background_url: "http://your-backend-api/payment/response",
                        background_url: "https://asia-southeast2-shopchamp-restaurant.cloudfunctions.net/paymentGateway/pgWebhook",
                        response_url: "http://your-frontend/payment/complete",
                        detail: "detail",
                        customer_name: "customer_name",
                        customer_email: "morris@example.com",
                        customer_address: "customer_address",
                        customer_telephone: "0987654321",
                        merchant_defined1: "any"
                    },
                    // timeout: 5000,
                };
                break;
            default:
                apiReq = {};
        }

        const response = await axios.request(apiReq);

        // console.log('response_status')
        // console.log(response.status)
        // console.log('typeof_response.data')
        // console.log(typeof response.data)

        // console.log('response_data')
        // console.log(response.data)

        if(
            response?.status === 200 
            && response?.data?.success === true
        ){

            let responsePayment = {};
            switch(paymentType){
                case 'qr_code':
                    // // ====== !!! follow api document but confuse at image type response
                    // const base64Image = "data:image/png;base64, "+response.data;
            
                    // console.log('base64Image');
                    // console.log(base64Image);
            
                    // const qrBlobImage = response.data;
                    // const qrImageUrl = URL.createObjectURL(qrBlobImage);
            
                    // // ====== !!! ask from provider, not error but not work
                    const qrBlobImage = new Blob([response.data], { type : 'image/png' });
                    const qrImageUrl = URL.createObjectURL(qrBlobImage)

                    responsePayment = qrImageUrl;
                    break;
                case 'qr_code_text':
                    const {data:{morris_reference_no, qr_code_text, reference_no}} = response.data;

                    responsePayment = { morris_reference_no, qr_code_text, reference_no };
                    break;
                case 'credit_card':
                    break;
                default:
                    responsePayment = {};
            }

            // console.log('responsePayment');
            // console.log(responsePayment);

            // console.log('return_val');
            // console.log({success:true,data:{...responsePayment}});

            functions.logger.info("function:payTransaction:info",{message:"Success_payTransaction"});
            if(paymentType === "qr_code"){
                return res.status(200).send({success:true,data:responsePayment});
            }else{
                return res.status(200).send({success:true,data:{...responsePayment}});
            }
            
        
        }else{
            // // ==== eg.

            // {
            //     success: false,
            //     response: { error_code: '404', error_message: 'Not Found Merchant' }
            // }

            const { error_code, error_message } = response?.data?.response; 

            // console.log('error_code')
            // console.log(error_code)
            // console.log('error_message')
            // console.log(error_message)

            if(error_code === '404' && error_message === 'Not Found Merchant'){
                functions.logger.error("function:payTransaction:catch", "not-found-merchant");
                return res.status(404).send({message:"payTransaction/not-found-merchant"});
            }else{
                functions.logger.error("function:payTransaction:catch", "request-not-error-but-payment-not-success");
                return res.status(500).send({message:"payTransaction/request-not-error-but-payment-not-success"});                
            }

        }

      
    }catch(err){

      console.log('catch_catch')
  
      return res.status(500).send({ 
        message: "Internal Server Error",
        error:err,
      });
  
    }
}


module.exports = app;


// get raw data and set change all firebase time ({_seconds,_nanoseconds}) to javasscript time 
// by change non offSettime {_seconds,_nanoseconds} to design offset time (UTC +7 = Thailand)
// can do every layer at whole object array or object
function convertFrbTimestampsToDates(data,utcOffset = 7) { // UTC +7 = Thailand
    if (data instanceof Object) {
        for (const key in data) {
            if (
                data[key] &&
                typeof data[key] === 'object' &&
                data[key]._seconds !== undefined &&
                data[key]._nanoseconds !== undefined &&
                Number.isInteger(data[key]._seconds) &&
                Number.isInteger(data[key]._nanoseconds)
            ) {
                // Convert Firestore timestamp to JavaScript Date object
                const seconds = data[key]._seconds;
                const nanoseconds = data[key]._nanoseconds;
                data[key] = new Date(seconds * 1000 + Math.round(nanoseconds / 1e6));

                // Adjust the time to UTC+7
                data[key].setHours(data[key].getHours() + utcOffset);
                // data[key].setHours(data[key].getHours() + 1);

            } else if (data[key] instanceof Object) {
                // Recursively process nested objects
                convertFrbTimestampsToDates(data[key],utcOffset);
            }
        }
    }
}

// get raw data and set change all firebase time ({_seconds,_nanoseconds}) to javasscript time 
// by change non offSettime {_seconds,_nanoseconds} to original offset from firestore
// must run at object (not whole object array)
// !Note! : has bug ,It still non offset datetime fix later.... 
function convertFrbTimestampsToDates2(data) {
    if (data instanceof Object) {
        for (const key in data) {
            if (
                data[key] &&
                typeof data[key] === 'object' &&
                data[key]._seconds !== undefined &&
                data[key]._nanoseconds !== undefined &&
                Number.isInteger(data[key]._seconds) &&
                Number.isInteger(data[key]._nanoseconds)
            ) {
                data[key] = data[key]?.toDate();

            } else if (data[key] instanceof Object) {
                // Recursively process nested objects
                convertFrbTimestampsToDates2(data[key]);
            }
        }
    }
}


function convertAnyDateFormatToJsDate(data, utcOffset = 7) { // UTC +7 = Thailand
  if (data instanceof Object) {
      for (const key in data) {
        if (
          data[key] &&
          typeof data[key] === 'object' &&
          (('seconds' in data[key] && 'nanoseconds' in data[key]) ||
           ('_seconds' in data[key] && '_nanoseconds' in data[key])) &&
          Number.isInteger(data[key].seconds || data[key]._seconds) &&
          Number.isInteger(data[key].nanoseconds || data[key]._nanoseconds)
        ) {
            // Determine the correct properties to use
            const seconds = data[key].seconds || data[key]._seconds;
            const nanoseconds = data[key].nanoseconds || data[key]._nanoseconds;
            // Convert Firestore timestamp to JavaScript Date object
            const date = new Date(seconds * 1000 + Math.round(nanoseconds / 1e6));
            // Note: Direct manipulation of time for timezone adjustment is not recommended
            // Consider using libraries like `moment-timezone` for accurate timezone handling

            // !!! Note : now will omit to adjust timezone by utc will fix later !!!

            // data[key] = new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + utcOffset, date.getUTCMinutes(), date.getUTCSeconds());
            data[key] = new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() , date.getUTCMinutes(), date.getUTCSeconds());
          } else if (typeof data[key] === 'string' && data[key].match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}(Z|[\+\-]\d{2}:\d{2})?$/)) {
              // Assuming the string represents local time if no timezone is specified
              // Convert ISO 8601 date strings to JavaScript Date objects
              let date = new Date(data[key]);

              // // ========= !!! this not correct to change timezone , do not use !!! ===============
              // Convert the date to UTC by subtracting the local timezone offset
              // date = new Date(date.getTime() + (date.getTimezoneOffset() * 60000));
              // Apply the utcOffset
              // date.setHours(date.getHours() + utcOffset);
              // // ========= !!!End of this not correct to change timezone , do not use !!! ===============

              // // !!!! Note: Now, the final result is still same utcOffset of input not change timezone will adapt later !!!!
              data[key] = date;
          } else if (data[key] instanceof Object) {
              // Recursively process nested objects
              convertAnyDateFormatToJsDate(data[key], utcOffset);
          }
      }
  }
}



async function sendPush(dataSet,filterQty = 1){
    try{

        const androidChannelIds = {
            urgent:'f291d5e7-95c7-411c-8f3a-2bdd44d183df',   // urgent => show on any app foreground (heading notification), vibration/sound/LED, icon on status bar, notification drawer
            high:'9f5c4b95-e7b0-4e4f-8bf5-c4829ac7dfbc',  // high => vibration/sound/LED, icon on status bar, notification drawer
            medium:'595f6b58-81ad-4d05-92c3-8c8ce193f544',  // medium => icon on status bar, notification drawer
            low:'3df6acc9-4aa5-41ee-afc5-459aa84b7920', // low =>   notification drawer
            updateProfileStatus:'c2f5e5c0-488b-432d-8144-50bcab1f0783',
        }
        
        const smallIcons = {
            ic_launcher:"ic_launcher",
            ic_launcher_round:"ic_launcher_round",
            ic_stat_onesignal_default:"ic_stat_onesignal_default"
        }

        const onesignalDefault = {
            heading:'',
            content:'',
            email:'siripongsrisukha@gmail.com',
            campaignName:'shopchamp_Onesignal',
            big_picture:'',
            url:'',
            data:'',
        };

        let config = {...onesignalDefault,...dataSet}

        const objSendPush = {
            ...config,
            android_channel_id: androidChannelIds.urgent,
            small_icon:smallIcons.ic_stat_onesignal_default,
            // small_icon:'https://entertain.teenee.com/thaistar/img5/927933.jpg',
            priority:10,
            enable_frequency_cap:false,
            objTargerUserCondition:{
                filters: [
                    ...(filterQty === 1 ? [{ field: "tag", key: "shopId", relation: "=", value: config?.shopId }] : []),
                    ...(filterQty === 2 ? [
                        { field: "tag", key: "id", relation: "=", value: config?.id },
                            { operator:"AND" },
                        { field: "tag", key: "shopId", relation: "=", value: config?.shopId }
                    ] : []),
                ]     
            }
        };


        // API like command
        let {heading,content,big_picture,small_icon,large_icon,url,data:pushData,campaignName,objTargerUserCondition,android_channel_id,priority,enable_frequency_cap} = {...onesignalDefault,...objSendPush};

        heading = heading ? heading : 'heading';
        content = content ? content : ``;
        // big_picture = big_picture ? big_picture : 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSKr5wT7rfkjkGvNeqgXjBmarC5ZNoZs-H2uMpML8O7Q4F9W-IlUQibBT6IPqyvX45NOgw&usqp=CAU';
        big_picture = big_picture ? big_picture : '';
        small_icon = small_icon ? small_icon : '';
        large_icon = large_icon ? large_icon : '';
        url = url ? url : '';
        pushData = pushData ? pushData : {abc: 123, foo: 'bar', event_performed: true, amount: 12.1} ;
        campaignName = campaignName ? campaignName : 'API_CAMPAIGN_NAME';
        objTargerUserCondition = objTargerUserCondition ? objTargerUserCondition : { included_segments: ['Subscribed Users'],};
        android_channel_id = android_channel_id ? android_channel_id : androidChannelIds.urgent;
        priority = priority ? priority : 10 ;
        enable_frequency_cap = enable_frequency_cap ? enable_frequency_cap : false ;

        const endpoint = 'https://onesignal.com/api/v1/notifications';  
        const params = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: 'Basic '+ env.onesignal_api_key,
            },
            body: JSON.stringify({
                headings:{ en: heading }, // can multiple language but now seem verbose , only "en" can English or Any Language Message
                contents: { en: content },
                big_picture:big_picture, // android only
                small_icon,small_icon,
                large_icon:large_icon,   // android only
                url: url, // optional
                data:pushData,  // attach data can read in clicked push listener ("setNotificationWillShowInForegroundHandler" , etc ....)
                name:campaignName, // name for tag message to monitor console ("delivery")
                ...objTargerUserCondition,
                // included_segments: ['Subscribed Users'],
                // include_player_ids:['49ae18b6-793b-11ec-9653-9a8760acd25e','4ca53c30-753e-11ec-b6b8-7e1709517f3b'],     // [vivo 1920 (11),sdk_gphone_arm64 (11)] : Limit of 2,000 entries per REST API call : send by "player_id" that collect from each devices of user
                // include_external_user_ids:['123456789'],
                // filters: [   // Will send notification only to specific device
                //   {          // Optional
                //     field: 'tag',
                //     key: 'Id',
                //     relation: '=',
                //     value: id,
                //   },
                // ],                        
                android_channel_id:android_channel_id,  // android only , nessacary to control notification level on mobile (ecpesscially "Urgent",cannot neglect it !)
                priority:priority, // for android,chrome , 10 = high priority ,other = normal priority
                enable_frequency_cap:enable_frequency_cap,  // false => break the rule quota limit message of user (if has set limit),against the total capped count ("frequency capping") (limit amount to send to user in setting time frequently eg. limit 5 message per hours (default) )
                app_id: env.onesignal_app_id,   // onesignal project id
            }),
        };
        // fetch(endpoint, params)


        const {status,jsonData:objRes} = await fetch(endpoint, params)
            .then(res => Promise.all([res.status, res.json()]))
            .then(([status, jsonData]) => { return {status:status,jsonData:jsonData} });


        // // !!!!!! will make better manage code when any function call this function to handle result response later .....
        if (status === 200){
            // functions.logger.info("function:sendPush:info",{message:"Success sendPush"});
            // res.status(200).send(objRes);

            return {status,objRes}
        }else {
            // functions.logger.error("function:sendPush:error",objRes?.errors);
            // res.status(status).send({message:"Internal Server Error",errors:objRes?.errors});

            // return objRes?.errors
            return {status,objRes}
            
        }
    }catch(err){
        
    }


}

