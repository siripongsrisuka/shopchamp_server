const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch-commonjs");   // config adjust of "node-fetch" ,for compatible with all javascript,ESM,node version, fetch require for production to cloudfunciton it not like local server It not know the basic commnad "fetch()"
const env = require("../env.json")
// const sdk = require('api')('@onesignal/v9.0#2v1qt7t1ylbmvbkys');

// import { checkIfAuthenticated } from "../middlewares/auth_middleware";
const { checkIfAuthenticated,checkIfAdmin } = require("../middlewares/auth_middleware");

const app = express();
app.use(cors({origin:true}));

// ############################### Build-in Support Function ##########################################

function modfObjForOneSignalTags(objTarget) {
    // Limitation of tags: 
    // 1) (may be,must test),for free plan ...
    //     1.1) tag to device can only 10 tags.If exceed => has error => need to either delete some tags, or upgrade to a paid OneSignal plan in order to add more.
    //     1.2) send notication with scope only 2 attribute (eg. 2 tags)
    // 2) Format ...
    //     2.1) store tags as string ,also in number,logical 
    //     2.2) can store time as unix time 
    //     2.3) not support arrays or other nested objects. Setting a tag value to null or an empty string will remove the tag
    // 3) 100 tags per API call
    // 4) Recommended to only tag devices with 1 kilobyte of data
    // 5) Android SDK users: tags cannot be removed or changed via API if set through SDK sendTag methods.Very should seperate between SDK tag process and API tag process

    // check date object format and turn to Unix time format, Unix time is a single signed number that increments every second, born at 01/01/1970  ,will die at 2038 (due to Binary number length maximum)
    // " Object.prototype.toString.call(objTarget[propName]) === '[object Date]' ",This will not fail if objects are passed across frame boundaries.A work-around for this is to check the object's class via ,!isNaN(test), for detect if time object will detect as number
    // Use Math.floor() to delete milli second (any turn between date object and unix time will lost milliseconds )
    // turn back to date object, var date = new Date(unix_timestamp * 1000);
    // turn objTags value to string (and time to Unix time format) to ensure to not bug when send to onesignal (store only in string format), may create this at API controller
    // when 'delete' an 'object' key.The key will have but value is 'undefined
    // tag to onesignal , if send 'undefined','null' => will make API request error
    // String() change  'undefined','null' to string.So,will "if (!objTarget[propName]) objTarget[propName] = '';" to change them to ''
    // check object value, not grant empty string value (""), for in onesignal will delete tag and may confuse with firestore still have key(key:"")
    // will grant delete tag only in build-in delete tag function both onesignal and firebase in function "onesignalDeleteUserTagsByExtUid"

    for (let propName in objTarget) {
        if ( Object.prototype.toString.call(objTarget[propName]) === '[object Date]' && 
        !isNaN(objTarget[propName]) ) {
            objTarget[propName] = Math.floor(objTarget[propName].getTime() / 1000);
        }
    
        if ( typeof objTarget[propName] === 'boolean' ) objTarget[propName] = String( objTarget[propName] );
        if ( ['object','function'].includes( typeof objTarget[propName]) ) delete objTarget[propName];  
        
        if ( !objTarget[propName] ) objTarget[propName] = '';
        objTarget[propName] = String( objTarget[propName] );
        if ( objTarget[propName].trim() === '' ) delete objTarget[propName];
    }

    return objTarget
}


function keyNameToEmptyStringObj(arr) {
    const objFromArr = {};
    for (let i = 0; i < arr.length; ++i)
        objFromArr[arr[i]] = '';
    return objFromArr;
}
  
  
// ############################### End of Build-in Support Function ##########################################






// ############################### Handle Tags and Device ##########################################

// getFullPlayerData
app.get("/getFullPlayerData/:player_id", async (req,res) => {
    try{
        const {player_id} = req.params;

        console.log('player_id:',player_id)

        const endpoint = 'https://onesignal.com/api/v1/players/'+player_id+'?app_id='+env.onesignal_app_id;  
        const params = {
            method: 'GET',
            headers: {
                accept: 'text/plain',
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: 'Basic '+ env.onesignal_api_key,
            }
        };
        const objFullPlayerData = await fetch(endpoint, params).then((response) => response.json()).then((data) => {return data});
        
        console.log("============= objFullPlayerData ==============")
        console.log('objFullPlayerData:',objFullPlayerData)
        // console.log(JSON.stringify(objFullPlayerData,null,4))
        // console.log(objFullPlayerData.json());

        functions.logger.info("function:getFullPlayerData:info",{message:"Success getFullPlayerData"});
        res.status(200).send(objFullPlayerData);
        // {
        //     "id": "b186912c-cf25-4688-8218-06cb13e09a4f",
        //     "identifier": "ce777617da7f548fe7a9ab6febb56cf39fba6d382000c0395666288d961ee566",
        //     "session_count": 1,
        //     "language": "en",
        //     "timezone": -28800,
        //     "game_version": "1.0",
        //     "device_os": "13.6.1",
        //     "device_type": 0,
        //     "device_model": "iPhone12,1",
        //     "ad_id": null,
        //     "tags": {
        //         "a": "1",
        //         "foo": "bar"
        //     },
        //     "last_active": 1598826147,
        //     "amount_spent": 0,
        //     "created_at": 1395096859,
        //     "invalid_identifier": false,
        //     "badge_count": 0,
        //     "sdk": "021502",
        //     "test_type": null,
        //     "ip": "2601:647:4b04:690:216a:4637:f37c:53ab",
        //     "external_user_id": null
        // }

    }catch(err){
        functions.logger.error("function:getFullPlayerData:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});


// setExternalUserId
app.put("/setExternalUserId/:player_id", async (req,res) => {
    // If using "Message Personalization", please allow 60+ seconds before sending your messages.
    const { player_id } = req.params
    const { external_user_id } = req.body;

    try{
        const endpoint = 'https://onesignal.com/api/v1/players/'+player_id;
        const params = {
            method: 'PUT',
            headers: {
                accept: 'text/plain',
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: 'Basic '+ env.onesignal_api_key,
            },
            body: JSON.stringify({
                app_id: env.onesignal_app_id,
                external_user_id:external_user_id
            }),
        };
        const objRes = await fetch(endpoint, params);

        functions.logger.info("function:setExternalUserId:info",{message:"Success setExternalUserId"});
        res.status(200).send(objRes);
        // {
        //     "success": true
        // }

    }catch(err){
        functions.logger.error("function:setExternalUserId:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});


// updateTagsByPlayerId
// app.put("/updateTagsByPlayerId/:player_id", async (req,res) => {
//     // If using "Message Personalization", please allow 60+ seconds before sending your messages.
//     const { player_id } = req.params
//     const { tags } = req.body;

//     console.log(player_id);
//     console.log(tags);

//     //'https://onesignal.com/api/v1/apps/APP_ID/users/EXTERNAL_USER_ID';
//     //'https://onesignal.com/api/v1/apps/'+env.onesignal_app_id+'/users/'+external_user_id;

//     //'https://onesignal.com/api/v1/players/PLAYER_ID';
//     //'https://onesignal.com/api/v1/players/'+player_id;

//     try{
//         const endpoint = 'https://onesignal.com/api/v1/players/'+player_id;
//         const params = {
//             method: 'PUT',
//             headers: {
//                 accept: 'text/plain',
//                 'Content-Type': 'application/json; charset=utf-8',
//                 Authorization: 'Basic '+ env.onesignal_api_key,
//             },
//             // body: JSON.stringify({
//             //     tags:{
//             //         first_name:'Win'
//             //     }
//             // }),
//             body: JSON.stringify({
//                 app_id: env.onesignal_app_id,
//                 tags:{...tags}
//             }),
//             // tags: {
//             //     first_name: 'Jon',       // add/update
//             //     key_to_delete: '""'      //   delete
//             // }
//         };
//         const objRes = await fetch(endpoint, params);

//         functions.logger.info("function:updateTagsByPlayerId:info",{message:"Success updateTagsByPlayerId"});
//         res.status(200).send(objRes);
//         // {
//         //     "success": true
//         // }

//     }catch(err){
//         functions.logger.error("function:updateTagsByPlayerId:error",err);
//         res.status(500).send({message:"Internal Server Error",error:err});
//     }
// });

app.put("/updateTagsByPlayerId/:player_id", async (req,res) => {
 
    try{
       
        res.status(200).send(null);
        // {
        //     "success": true
        // }

    }catch(err){
        functions.logger.error("function:updateTagsByPlayerId:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});







// initShopTagsByPlayerId
app.put("/initShopTagsByPlayerId/:player_id", async (req,res) => {
    // If using "Message Personalization", please allow 60+ seconds before sending your messages.
    const { player_id } = req.params
    const { objShop } = req.body;

    console.log(player_id);
    console.log(objShop);

    const selectedShopTags = {
        accountName :objShop?.accountName ? objShop?.accountName : '',
        accountNumber :objShop?.accountNumber ? objShop?.accountNumber : '',
        amphure :objShop?.amphure ? objShop?.amphure : '',
        bank :objShop?.bank ? objShop?.bank : '',
        dateTime :objShop?.dateTime ? new Date(objShop?.dateTime) : '',
        email :objShop?.email ? objShop?.email : '',
        eyosCampaign :objShop?.eyosCampaign ? objShop?.eyosCampaign : '',
        location :objShop?.location ? objShop?.location : '',
        name :objShop?.name ? objShop?.name : '',
        // nowLogIn :objShop?.nowLogIn ? objShop?.nowLogIn : '',
        // ownerName :objShop?.ownerName ? objShop?.ownerName : '',
        // postcode :objShop?.postcode ? objShop?.postcode : '',
        // promptpayId :objShop?.promptpayId ? objShop?.promptpayId : '',
        // province :objShop?.province ? objShop?.province : '',
        // scShopId :objShop?.scShopId ? objShop?.scShopId : '',
        // shopId :objShop?.shopId ? objShop?.shopId : '',
        // shopVerified :objShop?.shopVerified ? objShop?.shopVerified : '',
        // speedBarcode :objShop?.speedBarcode ? objShop?.speedBarcode : '',
        // status :objShop?.status ? objShop?.status : '',
        // tambon :objShop?.tambon ? objShop?.tambon : '',
        // taxInvoice :objShop?.taxInvoice ? objShop?.taxInvoice : '',
        // tel :objShop?.tel ? objShop?.tel : '',
    }


    const adjShopTags = await modfObjForOneSignalTags(selectedShopTags);
    // const adjShopTags = selectedShopTags;
    

    try{
        const endpoint = 'https://onesignal.com/api/v1/players/'+player_id;
        const params = {
            method: 'PUT',
            headers: {
                accept: 'text/plain',
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: 'Basic '+ env.onesignal_api_key,
            },
            // body: JSON.stringify({
            //     tags:{
            //         first_name:'Win'
            //     }
            // }),
            body: JSON.stringify({
                app_id: env.onesignal_app_id,
                tags:{...adjShopTags}
            }),
            // tags: {
            //     first_name: 'Jon',       // add/update
            //     key_to_delete: '""'      //   delete
            // }
        };
        const objRes = await fetch(endpoint, params);

        functions.logger.info("function:initShopTagsByPlayerId:info",{message:"Success initShopTagsByPlayerId"});
        res.status(200).send(objRes);
        // {
        //     "success": true
        // }

    }catch(err){
        functions.logger.error("function:initShopTagsByPlayerId:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});


// updateTagsByExternalUserId
app.put("/updateTagsByExternalUserId/:external_user_id", async (req,res) => {
    // If using "Message Personalization", please allow 60+ seconds before sending your messages.
    const { external_user_id } = req.params
    const { tags } = req.body;

    console.log(external_user_id);
    console.log(tags);

    try{
        const endpoint = 'https://onesignal.com/api/v1/apps/'+env.onesignal_app_id+'/users/'+external_user_id;
        const params = {
            method: 'PUT',
            headers: {
                accept: 'text/plain',
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: 'Basic '+ env.onesignal_api_key,
            },
            // body: JSON.stringify({
            //     tags:{
            //         first_name:'Win'
            //     }
            // }),
            body: JSON.stringify({
                tags:{...tags}
            }),
            // tags: {
            //     first_name: 'Jon',       // add/update
            //     key_to_delete: '""'      //   delete
            // }
        };
        const objRes = await fetch(endpoint, params);

        functions.logger.info("function:updateTagsByExternalUserId:info",{message:"Success updateTagsByExternalUserId"});
        res.status(200).send(objRes);
        // {
        //     "success": true
        // }

    }catch(err){
        functions.logger.error("function:updateTagsByExternalUserId:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});


// deleteTagsByPlayerId
app.delete("/deleteTagsByPlayerId/:player_id", async (req,res) => {
    // If using "Message Personalization", please allow 60+ seconds before sending your messages.
    const { player_id } = req.params
    const { arrTagsKey } = req.body;

    console.log('player_id:',player_id)
    console.log('arrTagsKey:',arrTagsKey)

    const objEmptyString = keyNameToEmptyStringObj([...arrTagsKey])     // ['dateTime','name','age']

    console.log('objEmptyString:',objEmptyString);

    try{
        const endpoint = 'https://onesignal.com/api/v1/players/'+player_id;
        const params = {
            method: 'PUT',
            headers: {
                accept: 'text/plain',
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: 'Basic '+ env.onesignal_api_key,
            },
            body: JSON.stringify({
                app_id: env.onesignal_app_id,
                tags:{...objEmptyString}
            }),
            // tags: {
            //     key_to_delete: '""'      //   delete
            // }
        };
        const objRes = await fetch(endpoint, params);

        functions.logger.info("function:deleteTagsByPlayerId:info",{message:"Success deleteTagsByPlayerId"});
        res.status(200).send(objRes);
        // {
        //     "success": true
        // }

    }catch(err){
        functions.logger.error("function:deleteTagsByPlayerId:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});



// deleteAllTagsByPlayerId
app.delete("/deleteAllTagsByPlayerId/:player_id", async (req,res) => {
    // If using "Message Personalization", please allow 60+ seconds before sending your messages.
    const { player_id } = req.params;

    const endpoint = 'https://onesignal.com/api/v1/players/'+player_id+'?app_id='+env.onesignal_app_id;  
        const params = {
            method: 'GET',
            headers: {
                accept: 'text/plain',
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: 'Basic '+ env.onesignal_api_key,
            }
        };
    const objFullPlayerData = await fetch(endpoint, params).then((response) => response.json()).then((data) => {return data});

    const arrAllTagsKey = Object.keys(objFullPlayerData?.tags);

    console.log(arrAllTagsKey);

    const objEmptyString = keyNameToEmptyStringObj([...arrAllTagsKey])     // ['dateTime','name','age']

    try{
        const endpoint = 'https://onesignal.com/api/v1/players/'+player_id;
        const params = {
            method: 'PUT',
            headers: {
                accept: 'text/plain',
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: 'Basic '+ env.onesignal_api_key,
            },
            body: JSON.stringify({
                app_id: env.onesignal_app_id,
                tags:{...objEmptyString}
            }),
            // tags: {
            //     key_to_delete: '""'      //   delete
            // }
        };
        const objRes = await fetch(endpoint, params);

        functions.logger.info("function:deleteAllTagsByPlayerId:info",{message:"Success deleteAllTagsByPlayerId"});
        res.status(200).send(objRes);
        // {
        //     "success": true
        // }

    }catch(err){
        functions.logger.error("function:deleteAllTagsByPlayerId:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});


// deleteTagsByExternalUserId
app.delete("/deleteTagsByExternalUserId/:external_user_id", async (req,res) => {
    // If using "Message Personalization", please allow 60+ seconds before sending your messages.
    const { external_user_id } = req.params
    const { arrTagsKey } = req.body;

    console.log(external_user_id);
    console.log(arrTagsKey);

    const objEmptyString = keyNameToEmptyStringObj([...arrTagsKey])     // ['dateTime','name','age']

    try{
        const endpoint = 'https://onesignal.com/api/v1/apps/'+env.onesignal_app_id+'/users/'+external_user_id;
        const params = {
            method: 'PUT',
            headers: {
                accept: 'text/plain',
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: 'Basic '+ env.onesignal_api_key,
            },
            // body: JSON.stringify({
            //     tags:{
            //         first_name:'Win'
            //     }
            // }),
            body: JSON.stringify({
                tags:{...objEmptyString}
            }),
            // tags: {
            //     first_name: 'Jon',       // add/update
            //     key_to_delete: '""'      //   delete
            // }
        };
        const objRes = await fetch(endpoint, params);

        functions.logger.info("function:deleteTagsByExternalUserId:info",{message:"Success deleteTagsByExternalUserId"});
        res.status(200).send(objRes);
        // {
        //     "success": true
        // }

    }catch(err){
        functions.logger.error("function:deleteTagsByExternalUserId:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});



// ############################### End of Handle Tags and Device ##########################################



// ############################### Send Push Notification ##########################################


// // sendPush
// app.get("/sendPush", async (req,res) => {
//     try{
//         // const {phoneNumber} = req.params;

//         const pushData = await sdk.createNotification(
//             {
//                 headings:{en:'heading'},
//                 contents: {en: 'English or Any Language Message'},
//                 big_picture:'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSKr5wT7rfkjkGvNeqgXjBmarC5ZNoZs-H2uMpML8O7Q4F9W-IlUQibBT6IPqyvX45NOgw&usqp=CAU', // for android only
//                 // large_icon:'',   // android
//                 // url: 'https://google.com', // optional
//                 data:{abc: 123, foo: 'bar', event_performed: true, amount: 12.1},
//                 name: 'INTERNAL_CAMPAIGN_NAME',
//                 included_segments: ['Subscribed Users'],
//                 // include_player_ids:['49ae18b6-793b-11ec-9653-9a8760acd25e','4ca53c30-753e-11ec-b6b8-7e1709517f3b'],     // [vivo 1920 (11),sdk_gphone_arm64 (11)] : Limit of 2,000 entries per REST API call : send by "player_id" that collect from each devices of user
//                 // include_external_user_ids:['123456789'],
//                 // filters: [   // Will send notification only to specific device
//                 //   {          // Optional
//                 //     field: 'tag',
//                 //     key: 'Id',
//                 //     relation: '=',
//                 //     value: id,
//                 //   },
//                 // ],                        
//                 android_channel_id:'30487017-ba42-4bc2-b2a7-9bf675015b02',
//                 priority:10, // for android,chrome , 10 = high priority ,other = normal priority
//                 enable_frequency_cap:false,  // break the rule quota limit message of user (if has set limit),against the total capped count ("frequency capping") (limit amount to send to user in setting time frequently eg. limit 5 message per hours (default) )
//             },
//             {
//                 authorization: 'Basic '+ env.onesignal_api_key
//             }
//         );

//         functions.logger.info("function:sendPush:info",{message:"Success Send Push"});
//         // res.status(200).send(pushData);
//         res.status(200).send({message:"Success Send Push"});
//     }catch(err){
//         functions.logger.error("function:sendPush:error",err);
//         res.status(500).send({message:"Internal Server Error",error:err});
//     }
// });



// sendPush
app.post("/sendPush", async (req,res) => {
    try{
        let {heading,content,big_picture,small_icon,large_icon,url,data,campaignName,objTargerUserCondition,android_channel_id,priority,enable_frequency_cap} = req.body;

        heading = heading ? heading : 'heading';
        content = content ? content : 'English or Any Language Message';
        // big_picture = big_picture ? big_picture : 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSKr5wT7rfkjkGvNeqgXjBmarC5ZNoZs-H2uMpML8O7Q4F9W-IlUQibBT6IPqyvX45NOgw&usqp=CAU';
        big_picture = big_picture ? big_picture : '';
        small_icon = small_icon ? small_icon : '';
        large_icon = large_icon ? large_icon : '';
        url = url ? url : '';
        data = data ? data : {abc: 123, foo: 'bar', event_performed: true, amount: 12.1} ;
        campaignName = campaignName ? campaignName : 'API_CAMPAIGN_NAME';
        objTargerUserCondition = objTargerUserCondition ? objTargerUserCondition : { included_segments: ['Subscribed Users'],};
        android_channel_id = android_channel_id ? android_channel_id : '30487017-ba42-4bc2-b2a7-9bf675015b02';
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
                data:data,  // attach data can read in clicked push listener ("setNotificationWillShowInForegroundHandler" , etc ....)
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
        fetch(endpoint, params)

        functions.logger.info("function:sendPush:info",{message:"Success Send Push"});
        // res.status(200).send(pushData);
        res.status(200).send({message:"Success Send Push"});
    }catch(err){
        functions.logger.error("function:sendPush:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});



// sendPush2
app.post("/sendPush2",checkIfAuthenticated ,async (req,res) => {
    try{
        let {heading,content,big_picture,small_icon,large_icon,url,data,campaignName,objTargerUserCondition,android_channel_id,priority,enable_frequency_cap} = req.body;

        heading = heading ? heading : 'heading';
        content = content ? content : 'English or Any Language Message';
        // big_picture = big_picture ? big_picture : 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSKr5wT7rfkjkGvNeqgXjBmarC5ZNoZs-H2uMpML8O7Q4F9W-IlUQibBT6IPqyvX45NOgw&usqp=CAU';
        big_picture = big_picture ? big_picture : '';        small_icon = small_icon ? small_icon : '';
        large_icon = large_icon ? large_icon : '';
        url = url ? url : '';
        data = data ? data : {abc: 123, foo: 'bar', event_performed: true, amount: 12.1} ;
        campaignName = campaignName ? campaignName : 'API_CAMPAIGN_NAME';
        objTargerUserCondition = objTargerUserCondition ? objTargerUserCondition : { included_segments: ['Subscribed Users'],};
        android_channel_id = android_channel_id ? android_channel_id : '30487017-ba42-4bc2-b2a7-9bf675015b02';
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
                // url: url, // optional
                data:data,  // attach data can read in clicked push listener ("setNotificationWillShowInForegroundHandler" , etc ....)
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
        fetch(endpoint, params)

        functions.logger.info("function:sendPush2:info",{message:"Success Send Push"});
        // res.status(200).send(pushData);
        res.status(200).send({message:"Success Send Push"});
    }catch(err){
        functions.logger.error("function:sendPush2:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});


// sendPush3
app.post("/sendPush3",checkIfAdmin ,async (req,res) => {
    try{
        let {heading,content,big_picture,small_icon,large_icon,url,data,campaignName,objTargerUserCondition,android_channel_id,priority,enable_frequency_cap} = req.body;

        heading = heading ? heading : 'heading';
        content = content ? content : 'English or Any Language Message';
        // big_picture = big_picture ? big_picture : 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSKr5wT7rfkjkGvNeqgXjBmarC5ZNoZs-H2uMpML8O7Q4F9W-IlUQibBT6IPqyvX45NOgw&usqp=CAU';
        big_picture = big_picture ? big_picture : '';        small_icon = small_icon ? small_icon : '';
        large_icon = large_icon ? large_icon : '';
        url = url ? url : '';
        data = data ? data : {abc: 123, foo: 'bar', event_performed: true, amount: 12.1} ;
        campaignName = campaignName ? campaignName : 'API_CAMPAIGN_NAME';
        objTargerUserCondition = objTargerUserCondition ? objTargerUserCondition : { included_segments: ['Subscribed Users'],};
        android_channel_id = android_channel_id ? android_channel_id : '30487017-ba42-4bc2-b2a7-9bf675015b02';
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
                // url: url, // optional
                data:data,  // attach data can read in clicked push listener ("setNotificationWillShowInForegroundHandler" , etc ....)
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
        fetch(endpoint, params)

        functions.logger.info("function:sendPush3:info",{message:"Success Send Push"});
        // res.status(200).send(pushData);
        res.status(200).send({message:"Success Send Push"});
    }catch(err){
        functions.logger.error("function:sendPush3:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});

// ############################### End of Send Push Notification ##########################################

module.exports = app;
