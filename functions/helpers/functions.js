const functions = require("firebase-functions");
const axios = require("axios");
const FormData = require('form-data');
const env = require("../env.json");

exports.stringDateTimeReceipt = function(day){
  const date = new Date(day)
  const cDateTime =
      date.getDate().toString().padStart(2,"0") + "/"+
      parseInt(date.getMonth()+1).toString().padStart(2,"0") +"/"+
      date.getFullYear().toString().padStart(4,"0")+" " +
      date.getHours().toString().padStart(2,"0")+":"+
      date.getMinutes().toString().padStart(2,"0")

  return cDateTime;  // 27/06/2021 00:25:26
}



exports.formatTime = function(dateInput) {
  let date;

  if (dateInput instanceof Date) {
    date = dateInput;
  } else if (dateInput && typeof dateInput === 'object' && 'seconds' in dateInput && 'nanoseconds' in dateInput) {
    date = new Date(dateInput.seconds * 1000 + dateInput.nanoseconds / 1000000);
  } else if (dateInput && typeof dateInput === 'object' && '_seconds' in dateInput && '_nanoseconds' in dateInput) {
    date = new Date(dateInput._seconds * 1000 + dateInput._nanoseconds / 1000000);
  } else {
    date = new Date(dateInput);
  }

  return date;
};




exports.summary = function(arr,propertise){
  let sum = arr?.reduce((a, b) => Number(a) + (Number(b[propertise]) || 0), 0);
  return sum
};



exports.sendLineNotify = async function({lineNotifyToken, message, base64Image, stickerPackageId, stickerId, notificationDisabled = false }){
  try{
    const formData = new FormData();

    formData.append('message', message);
    if (base64Image) {
      const buffer = Buffer.from(base64Image, 'base64');
      formData.append('imageFile', buffer, {
        filename: 'image.jpg',
        contentType: 'image/jpeg', 
      });
    }
    if (stickerPackageId && stickerId) {
      formData.append('stickerPackageId', stickerPackageId);    // 11537
      formData.append('stickerId', stickerId);    // 52002740
    }
    formData.append('notificationDisabled',String(notificationDisabled));

    // const response = await axios({
    //   method: "POST",
    //   url: "https://notify-api.line.me/api/notify",
    //   headers: {
    //     "Content-Type": "application/x-www-form-urlencoded",
    //     Authorization: `Bearer ${lineNotifyToken}`, 
    //   },
    //   data:`message= ${message}`,   // max length is 1,000 
    //   // timeout: 5000,
    //   // timeout: 1,
    // })

    const response = await axios({
      method: "POST",
      url: "https://notify-api.line.me/api/notify",
      headers: {
        ...formData.getHeaders(),
        Authorization: `Bearer ${lineNotifyToken}`, 
      },
      data: formData,   // message: max length is 1,000 , imageFile : max 1 MB
      timeout: 4000,
      // timeout: 1,
    })

    console.log('sendLineNotify_response')
    // console.log(response);

    // // // may modify response if "response.status = 200" but "response.data" has some key tell no fail/non complete something
    // // { status: 200 , message: 'xxx } 
    // // In this time , not found this pattern, So, not to do anything
    // if(response.data?.status !== 200){
    //   

    // }else{
    //   return response // Return the full response to handle status codes in file1.js
    // }

    return response

  }catch(err){
    console.log('sendLineNotify_err');
    // console.log(err);

    // Throw a sanitized error object, to handle error in file1.js
    if (err.response) {   // // not make error on calling layer, cause it reject by axios and has go to this scope (catch), reject or error can only go to catch scpoe one time if want more than one must thow error to make error again on outside layer
      console.log('sendLineNotify_err_response');
      console.log('Error data:', err.response.data); // The data returned by the server
      console.log('Error status:', err.response.status); // The HTTP status code
      console.log('Error headers:', err.response.headers); // The response headers
      // console.log('Error message:', err.message); // The error message 

      // return err.response;   // If the error has a response, return it to handle in file1.js by not make error (seem not proper in some case)
      // throw err.response;   // direct return value, may be make error when "JSON.stringfy()" value or verbose in some log type eg.
      throw {
        type: 'response_error',
        status: err.response.status,
        message: err.response.data.message,
        data: err.response.data,
      };
    } else if(err.request){   // // not make error on calling layer, as well first condition
      if (err.code === 'ECONNABORTED') {     // Specific check for timeout error (ECONNABORTED)
        console.log('sendLineNotify_err_Request_timeout_(ECONNABORTED)');

        // return err.request;
        // throw err.request;
        throw {
          type: 'request_error',
          message: 'sendLineNotify_err_Request_timeout_(ECONNABORTED)',
          details: err.message,
        };
      }else{
        console.log('sendLineNotify_err_request');
        console.log(err.request)

        // return err.request;
        // throw err.request;
        throw {
          type: 'request_error',
          message: 'No response received',
          details: err.message,
        };
      }

    } else {    // // make error on calling layer, if use "try/catch" will trigger catch scope "functions.logger()""
      console.log('sendLineNotify_err_else');
      console.log(err)

      // throw err; // If there is no response (network error, etc.), throw the error to be caught in file1.js

      // return {success:false, data:{message:error.message}};
      throw {
        type: 'unknown_error',
        message: err.message || 'Unknown error',
      };
    }

  }
};


exports.handleApiResponseAndEndRequest = function({response, res, routeName , successMessage = "Operation successful"}) {
  const status = response?.status;

  switch (status) {
    case 200:
      functions.logger.info(`function:${routeName}:info`, { status, message: successMessage });
      return res.status(200).send({ status, message: successMessage });
      
    case 400:
      functions.logger.warn(`function:${routeName}:warn`, { status, message: "Bad Request" });
      return res.status(400).send({ status, message: "Bad Request" });
      
    case 401:
      functions.logger.warn(`function:${routeName}:warn`, { status, message: "Unauthorized - Invalid token" });
      return res.status(401).send({ status, message: "Unauthorized - Invalid token" });
      
    case 500:
      functions.logger.error(`function:${routeName}:error`, { status, message: "Server error" });
      return res.status(500).send({ status, message: "Server error" });
    
    case undefined:
      functions.logger.error(`function:${routeName}:error`, { status, message: "Undefined response status" });
      return res.status(500).send({ status, message: "Undefined response status" });
      
    default:
      functions.logger.error(`function:${routeName}:error`, { status, message: "Unknown error" });
      return res.status(status).send({ status, message: "Unknown error" });
  }
}

exports.sendPush = async function (dataSet,filterQty = 1){ // ใช้ได้ทั้ง oneFilter และ twoFilter
  try{

      const androidChannelIds = {
        urgent:'7e7e2dd1-21e9-4959-b189-f24336e04542',   // urgent => show on any app foreground (heading notification), vibration/sound/LED, icon on status bar, notification drawer
        high:'20bdb8b0-68a3-4597-8580-5058b2687499',  // high => vibration/sound/LED, icon on status bar, notification drawer
        medium:'cac25f9b-590b-4384-a497-5b6e6bbb0c5f',  // medium => icon on status bar, notification drawer
        low:'ca049df5-530d-4459-998a-dcbee4b44cdf', // low =>   notification drawer
        updateProfileStatus:'8c8d3208-9d2c-446a-b1d1-3f379728eac6',
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
      campaignName = campaignName ? campaignName : 'API_CAMPAIGN_NAME';
      objTargerUserCondition = objTargerUserCondition ? objTargerUserCondition : { included_segments: ['Subscribed Users'],};
      android_channel_id = android_channel_id ? android_channel_id : '7e7e2dd1-21e9-4959-b189-f24336e04542';
      priority = priority ? priority : 10 ;
      enable_frequency_cap = enable_frequency_cap ? enable_frequency_cap : false ;

      const endpoint = 'https://onesignal.com/api/v1/notifications';  
      const params = {
          method: 'POST',
          headers: {
              'Content-Type': 'application/json; charset=utf-8',
              Authorization: 'Basic '+ env.onesignal_api_key_scanFood,
          },
          body: JSON.stringify({
              headings:{ en: heading }, // can multiple language but now seem verbose , only "en" can English or Any Language Message
              contents: { en: content },
              big_picture:big_picture, // android only
              small_icon,small_icon,
              large_icon:large_icon,   // android only
              // url: url, // optional
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
              app_id: env.onesignal_app_id_scanFood,   // onesignal project id
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