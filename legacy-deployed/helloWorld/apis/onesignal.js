const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch-commonjs");   // config adjust of "node-fetch" ,for compatible with all javascript,ESM,node version
const env = require("../env.json")
// const sdk = require('api')('@onesignal/v9.0#2v1qt7t1ylbmvbkys');

// import { checkIfAuthenticated } from "../middlewares/auth_middleware";
const { checkIfAuthenticated } = require("../middlewares/auth_middleware");

const app = express();
app.use(cors({origin:true}));


// sendPush
app.post("/sendPush", async (req,res) => {
    try{
        let {heading,content,big_picture,small_icon,large_icon,url,data,campaignName,objTargerUserCondition,android_channel_id,priority,enable_frequency_cap} = req.body;

        heading = heading ? heading : 'heading';
        content = content ? content : 'English or Any Language Message';
        big_picture = big_picture ? big_picture : 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSKr5wT7rfkjkGvNeqgXjBmarC5ZNoZs-H2uMpML8O7Q4F9W-IlUQibBT6IPqyvX45NOgw&usqp=CAU';
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

        functions.logger.info("function:sendPush:info",{message:"Success Send Push"});
        // res.status(200).send(pushData);
        res.status(200).send({message:"Success Send Push"});
    }catch(err){
        functions.logger.error("function:sendPush:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});



// sendPush
app.post("/sendPush2",checkIfAuthenticated ,async (req,res) => {
    try{
        let {heading,content,big_picture,small_icon,large_icon,url,data,campaignName,objTargerUserCondition,android_channel_id,priority,enable_frequency_cap} = req.body;

        heading = heading ? heading : 'heading';
        content = content ? content : 'English or Any Language Message';
        big_picture = big_picture ? big_picture : 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSKr5wT7rfkjkGvNeqgXjBmarC5ZNoZs-H2uMpML8O7Q4F9W-IlUQibBT6IPqyvX45NOgw&usqp=CAU';
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

        functions.logger.info("function:sendPush:info",{message:"Success Send Push"});
        // res.status(200).send(pushData);
        res.status(200).send({message:"Success Send Push"});
    }catch(err){
        functions.logger.error("function:sendPush:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});



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



// getFullPlayerData
app.get("/getFullPlayerData/:player_id", async (req,res) => {
    try{
        const {player_id} = req.params;

        const endpoint = 'https://onesignal.com/api/v1/players/'+player_id+'?app_id='+env.onesignal_app_id;  
        const params = {
            method: 'GET',
            headers: {
                accept: 'text/plain',
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: 'Basic '+ env.onesignal_api_key,
            }
        };
        const objFullPlayerData = await fetch(endpoint, params);

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



// updateTagsByExternalUserId
app.put("/updateTagsByExternalUserId/:external_user_id", async (req,res) => {
    // If using "Message Personalization", please allow 60+ seconds before sending your messages.

    try{
        const endpoint = 'https://onesignal.com/api/v1/apps/'+env.onesignal_app_id+'/users/'+external_user_id;
        const params = {
            method: 'PUT',
            headers: {
                accept: 'text/plain',
                'Content-Type': 'application/json; charset=utf-8',
                Authorization: 'Basic '+ env.onesignal_api_key,
            },
            body: JSON.stringify({...req.body}),    // tags
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


module.exports = app;
