const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch-commonjs");   // config adjust of "node-fetch" ,for compatible with all javascript,ESM,node version
const axios = require("axios");
const env = require("../env.json");

const app = express();
app.use(cors({origin:true}));

var db = admin.firestore(); // Initialize Firestore database

const { checkSharedDataGrantUser, validateAndRefeshAuthToken, checkIfAuthenticated } = require("../middlewares/auth_middleware");

// checkPhoneRegister

function convertArrayToObjects(array) {
  return array.map(item => ({
    type: "text",
    text: item
  }));
};

app.post("/checkin/", async (req, res) => {
  try {
      const { 
          user, // This should now be an array of user IDs
          channelAccessToken,
          type = 'เข้างาน',
          time,
          url,
          tel
      } = req.body;

      // Log request info
      functions.logger.info("function:checkPhoneRegister:info", { message: "Found Registered Users" });

      // Iterate through the user IDs and send messages
      const promises = user.map(async (userId) => {
          let data = JSON.stringify({
              "to": userId,
              "messages": [
                  {
                      "type": "flex",
                      "altText": `แจ้งเตือน เข้า - ออกงาน `,
                      "contents": {
                        "type": "bubble",
                        "body": {
                          "type": "box",
                          "layout": "vertical",
                          "contents": [
                            {
                              "type": "text",
                              "text": "เข้า - ออก งาน",
                              "weight": "bold",
                              "size": "xl"
                            },
                            {
                              "type": "box",
                              "layout": "vertical",
                              "margin": "lg",
                              "spacing": "sm",
                              "contents": [
                                {
                                  "type": "box",
                                  "layout": "baseline",
                                  "spacing": "sm",
                                  "contents": [
                                    {
                                      "type": "text",
                                      "text": "ประเภท",
                                      "color": "#aaaaaa",
                                      "size": "sm",
                                      "flex": 1
                                    },
                                    {
                                      "type": "text",
                                      "text": type,
                                      "wrap": true,
                                      "color": "#666666",
                                      "size": "sm",
                                      "flex": 4
                                    }
                                  ]
                                },
                                {
                                  "type": "box",
                                  "layout": "baseline",
                                  "spacing": "sm",
                                  "contents": [
                                    {
                                      "type": "text",
                                      "text": "เวลา",
                                      "color": "#aaaaaa",
                                      "size": "sm",
                                      "flex": 1
                                    },
                                    {
                                      "type": "text",
                                      "text": time,
                                      "wrap": true,
                                      "color": "#666666",
                                      "size": "sm",
                                      "flex": 4
                                    }
                                  ]
                                }
                              ]
                            },
                            {
                              "type": "image",
                              "url": url,
                              "size": "3xl"
                            }
                          ]
                        },
                        "footer": {
                          "type": "box",
                          "layout": "vertical",
                          "spacing": "sm",
                          "contents": [
                            {
                              "type": "button",
                              "style": "link",
                              "height": "sm",
                              "action": {
                                "type": "uri",
                                "label": "โทร",
                                "uri": `tel:${tel}`
                              }
                            },
                            {
                              "type": "box",
                              "layout": "vertical",
                              "contents": [],
                              "margin": "sm"
                            }
                          ],
                          "flex": 0
                        }
                      }
                  }
              ]
          });

          let config = {
              method: 'post',
              maxBodyLength: Infinity,
              url: 'https://api.line.me/v2/bot/message/push',
              headers: { 
                  'Content-Type': 'application/json', 
                  'Authorization': `Bearer ${channelAccessToken}`
              },
              data: data
          };

          // Send request to LINE API
          return axios.request(config);
      });

      // Wait for all messages to be sent
      await Promise.all(promises);

      // Respond to the original request
      res.status(200).send('Messages sent successfully');
  } catch (err) {
      // Log error and respond with error message
      functions.logger.error("function:checkPhoneRegister:error", err);
      res.status(500).send({ error: err });
  }
});

app.post("/line/", async (req, res) => {
  try {
      const { 
          user, // This should now be an array of user IDs
          contents,
          channelAccessToken,
          shopName
      } = req.body;

      // Log request info
      functions.logger.info("function:checkPhoneRegister:info", { message: "Found Registered Users" });

      // Iterate through the user IDs and send messages
      const promises = user.map(async (userId) => {
          let data = JSON.stringify({
              "to": userId,
              "messages": [
                  {
                      "type": "flex",
                      "altText": `คำสั่งซื้อ ร้าน${shopName} `,
                      "contents": {
                          "type": "bubble",
                          "header": {
                              "type": "box",
                              "layout": "vertical",
                              "contents": [
                                  {
                                      "type": "text",
                                      "text": "ขอบคุณสำหรับคำสั่งซื้อ",
                                      "color": "#ffffff",
                                      "weight": "bold",
                                      "style": "normal"
                                  }
                              ],
                              "action": {
                                  "type": "message",
                                  "label": "action",
                                  "text": "hello world"
                              }
                          },
                          "body": {
                              "type": "box",
                              "layout": "vertical",
                              "contents": contents
                          },
                          "styles": {
                              "header": {
                                  "backgroundColor": "#00B900"
                              }
                          }
                      }
                  }
              ]
          });

          let config = {
              method: 'post',
              maxBodyLength: Infinity,
              url: 'https://api.line.me/v2/bot/message/push',
              headers: { 
                  'Content-Type': 'application/json', 
                  'Authorization': `Bearer ${channelAccessToken}`
              },
              data: data
          };

          // Send request to LINE API
          return axios.request(config);
      });

      // Wait for all messages to be sent
      await Promise.all(promises);

      // Respond to the original request
      res.status(200).send('Messages sent successfully');
  } catch (err) {
      // Log error and respond with error message
      functions.logger.error("function:checkPhoneRegister:error", err);
      res.status(500).send({ error: err });
  }
});

app.post("/broadcast/", async (req, res) => {
    try {
        const { 
            user, // This should now be an array of user IDs
            messages,
            channelAccessToken,
        } = req.body;
  
        // Log request info
        functions.logger.info("function:checkPhoneRegister:info", { message: "Found Registered Users" });
  
        // Iterate through the user IDs and send messages
        const promises = user.map(async (userId) => {
            let data = JSON.stringify({
                "to": userId,
                "messages": messages
            });
  
            let config = {
                method: 'post',
                maxBodyLength: Infinity,
                url: 'https://api.line.me/v2/bot/message/push',
                headers: { 
                    'Content-Type': 'application/json', 
                    'Authorization': `Bearer ${channelAccessToken}`
                },
                data: data
            };
  
            // Send request to LINE API
            return axios.request(config);
        });
  
        // Wait for all messages to be sent
        await Promise.all(promises);
  
        // Respond to the original request
        res.status(200).send('Messages sent successfully');
    } catch (err) {
        // Log error and respond with error message
        functions.logger.error("function:checkPhoneRegister:error", err);
        res.status(500).send({ error: err });
    }
});
app.post("/openShift/", async (req, res) => {
    try {
      const {
        user, // Array of user IDs
        channelAccessToken,
        shopName,
        cashierName,
        shiftCount,
        date,
        openName,
        openCash
      } = req.body;
  
      // Validate required fields
      if (
        !Array.isArray(user) ||
        !channelAccessToken ||
        !shopName ||
        !cashierName ||
        !shiftCount ||
        !date ||
        !openName ||
        !openCash
      ) {
        return res.status(400).send({ error: "Missing required parameters." });
      }
  
      // Log request info
      functions.logger.info("function:openShift:info", {
        message: "Sending open shift notifications",
        toUsers: user.length
      });
  
      const promises = user.map(async (userId) => {
        const data = JSON.stringify({
          to: userId,
          messages: [
            {
              type: "flex",
              altText: "แจ้งเตือนเปิดกะ",
              contents: {
                type: "bubble",
                body: {
                  type: "box",
                  layout: "vertical",
                  contents: [
                    {
                      type: "text",
                      text: shopName,
                      weight: "bold",
                      size: "xl",
                    },
                    {
                      type: "box",
                      layout: "vertical",
                      margin: "lg",
                      spacing: "sm",
                      contents: [
                        {
                          type: "box",
                          layout: "baseline",
                          spacing: "sm",
                          contents: [
                            {
                              type: "text",
                              text: "เครื่องชำระเงิน",
                              color: '#000000',
                              size: "sm",
                              flex: 1,
                            },
                            {
                              type: "text",
                              text: cashierName,
                              wrap: true,
                              color: "#666666",
                              size: "sm",
                              flex: 2,
                            },
                          ],
                        },
                        {
                          type: "box",
                          layout: "baseline",
                          spacing: "sm",
                          contents: [
                            {
                              type: "text",
                              text: "กะที่",
                              color: '#000000',
                              size: "sm",
                              flex: 1,
                            },
                            {
                              type: "text",
                              text: shiftCount,
                              wrap: true,
                              color: "#666666",
                              size: "sm",
                              flex: 2,
                            },
                          ],
                        },
                        {
                          type: "box",
                          layout: "baseline",
                          spacing: "sm",
                          contents: [
                            {
                              type: "text",
                              text: "วันที่ - เวลา",
                              color: '#000000',
                              size: "sm",
                              flex: 1,
                            },
                            {
                              type: "text",
                              text: date,
                              wrap: true,
                              color: "#666666",
                              size: "sm",
                              flex: 2,
                            },
                          ],
                        },
                        {
                          type: "box",
                          layout: "baseline",
                          spacing: "sm",
                          contents: [
                            {
                              type: "text",
                              text: "เปิดกะโดย",
                              color: '#000000',
                              size: "sm",
                              flex: 1,
                            },
                            {
                              type: "text",
                              text: openName,
                              wrap: true,
                              color: "#666666",
                              size: "sm",
                              flex: 2,
                            },
                          ],
                        },
                        {
                          type: "box",
                          layout: "baseline",
                          spacing: "sm",
                          contents: [
                            {
                              type: "text",
                              text: "ยอดเงินเปิดกะ",
                              color: '#000000',
                              size: "sm",
                              flex: 1,
                            },
                            {
                              type: "text",
                              text: openCash,
                              wrap: true,
                              color: "#666666",
                              size: "sm",
                              flex: 2,
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
                footer: {
                  type: "box",
                  layout: "vertical",
                  contents: [
                    {
                      type: "text",
                      text: "พัฒนาโดย ช็อปแชมป์",
                      align: "center",
                      size: "xs",
                      color: "#999999",
                    },
                  ],
                },
              },
            },
          ],
        });
  
        const config = {
          method: "post",
          maxBodyLength: Infinity,
          url: "https://api.line.me/v2/bot/message/push",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${channelAccessToken}`,
          },
          data,
        };
  
        return axios.request(config);
      });
  
      await Promise.all(promises);
  
      res.status(200).send("Messages sent successfully");
    } catch (err) {
      functions.logger.error("function:openShift:error", err);
      res.status(500).send({ error: err.message || "Something went wrong." });
    }
  });
  
  app.post("/image/", async (req, res) => {
    try {
        const { 
            user, // This should now be an array of user IDs
            channelAccessToken,
            imageId
        } = req.body;
  
        // Log request info
        functions.logger.info("function:checkPhoneRegister:info", { message: "Found Registered Users" });
  
        // Iterate through the user IDs and send messages
        const promises = user.map(async (userId) => {
            let data = JSON.stringify({
                "to": userId,
                "messages": [
                    {
                        type: "image",
                        originalContentUrl: imageId, // Must be HTTPS
                        previewImageUrl: imageId  // Usually same as original, but can be smaller
                    }
                ]
            });
  
            let config = {
                method: 'post',
                maxBodyLength: Infinity,
                url: 'https://api.line.me/v2/bot/message/push',
                headers: { 
                    'Content-Type': 'application/json', 
                    'Authorization': `Bearer ${channelAccessToken}`
                },
                data: data
            };
  
            // Send request to LINE API
            return axios.request(config);
        });
  
        // Wait for all messages to be sent
        await Promise.all(promises);
  
        // Respond to the original request
        res.status(200).send('Messages sent successfully');
    } catch (err) {
        // Log error and respond with error message
        functions.logger.error("function:checkPhoneRegister:error", err);
        res.status(500).send({ error: err });
    }
  });

app.post("/message/", async (req, res) => {
  try {
      const { 
          user, // This should now be an array of user IDs
          contents,
          channelAccessToken,
      } = req.body;

      // Log request info
      functions.logger.info("function:checkPhoneRegister:info", { message: "Found Registered Users" });

      // Iterate through the user IDs and send messages
      const promises = user.map(async (userId) => {
          let data = JSON.stringify({
              "to": userId,
              "messages": [
                  {
                      "type": "text",
                      "text":contents
                  }
              ]
          });

          let config = {
              method: 'post',
              maxBodyLength: Infinity,
              url: 'https://api.line.me/v2/bot/message/push',
              headers: { 
                  'Content-Type': 'application/json', 
                  'Authorization': `Bearer ${channelAccessToken}`
              },
              data: data
          };

          // Send request to LINE API
          return axios.request(config);
      });

      // Wait for all messages to be sent
      await Promise.all(promises);

      // Respond to the original request
      res.status(200).send('Messages sent successfully');
  } catch (err) {
      // Log error and respond with error message
      functions.logger.error("function:checkPhoneRegister:error", err);
      res.status(500).send({ error: err });
  }
});

// app.post("/line/", async (req, res) => {
//     try {
//       const { 
//         user,
//         contents,
//         channelAccessToken,
//         shopName
//       } = req.body;
//         // Log request info
//         functions.logger.info("function:checkPhoneRegister:info", { message: "Found Registered User" });
        
//         // Prepare data for LINE API
//         let data = JSON.stringify({
//             // "to": "U4bc2837bd7c280b0567444ed6c297d9e",
//             "to": user,
//             "messages": [
//             {
//               "type": "flex",
//               "altText": `คำสั่งซื้อ ร้าน${shopName} `,
//               // "altText": "คำสั่งซื้อ ร้านตำกระด้ง ",
//               "contents": {
//                 "type": "bubble",
//               "header": {
//                 "type": "box",
//                 "layout": "vertical",
//                 "contents": [
//                   {
//                     "type": "text",
//                     "text": "ขอบคุณสำหรับคำสั่งซื้อ",
//                     "color": "#ffffff",
//                     "weight": "bold",
//                     "style": "normal"
//                   }
//                 ],
//                 "action": {
//                   "type": "message",
//                   "label": "action",
//                   "text": "hello world"
//                 }
//               },
//               "body": {
//                 "type": "box",
//                 "layout": "vertical",
//                 "contents": contents
//               },
//               "styles": {
//                 "header": {
//                   "backgroundColor": "#00B900"
//                 }
//               }
//               }
//             }
//           ]
//         });

//         let config = {
//             method: 'post',
//             maxBodyLength: Infinity,
//             url: 'https://api.line.me/v2/bot/message/push',
//             headers: { 
//                 'Content-Type': 'application/json', 
//                 'Authorization': `Bearer ${channelAccessToken}`
//             },
//             data: data
//         };

//         // Send request to LINE API
//         let response = await axios.request(config);
//         console.log(JSON.stringify(response.data));
        
//         // Respond to the original request
//         res.status(200).send('successfully');
//     } catch (err) {
//         // Log error and respond with error message
//         functions.logger.error("function:checkPhoneRegister:error", err);
//         res.status(500).send({ error: err });
//     }
// });

const LINE_MESSAGING_API = 'https://api.line.me/v2/bot/message';
const LINE_HEADER = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer oihNuOugpk3oSrYRdwMucB1SKLg3ylKLdyacFjPjbdvkFYbCSMVRloXqKzcXkPFo5DtImEluiEKhnLVbX/cLbHRJEAWjtTN9BheHoy1TM53j92+1/SjVRZdkq6s6McRYDFyz634Sp8W9CpJZDEJrKAdB04t89/1O/w1cDnyilFU=`
  // 'Authorization': `Bearer oihNuOugpk3oSrYRdwMucB1SKLg3ylKLdyacFjPjbdvkFYbCSMVRloXqKzcXkPFo5DtImEluiEKhnLVbX/cLbHRJEAWjtTN9BheHoy1TM53j92+1/SjVRZdkq6s6McRYDFyz634Sp8W9CpJZDEJrKAdB04t89/1O/w1cDnyilFU=`
};

const REPLY_COOLDOWN = 15 * 60 * 1000; // 15 นาที

app.post("/line/webHook", async (req, res) => {
    if (req.body.events[0].message.type !== 'text') {
        return;
      }
    try {
        // Respond to the original request
        reply(req.body.events[0])
        // reply(req.body)
        res.status(200).send('OK');
    } catch (err) {
        // Log error and respond with error message
        functions.logger.error("function:checkPhoneRegister:error", err);
        res.status(500).send({ error: err });
    }
});

const reply = async (event) => {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const shouldSend = await shouldReply(userId);
  if (!shouldSend) {
    console.log('Already replied recently. Skipping...');
    return;
  }

  const now = new Date();
  const hour = now.getHours() +7;

  let text = '';

  if (hour >= 9 && hour < 24) {
    // เวลาทำการ 09:00 - 23:59
    text = `สวัสดีครับ 🙏 ขอบคุณที่ทักมาหา ScanFood นะครับ\n\nเราได้รับข้อความเรียบร้อยแล้ว ทีมแอดมินจะเข้ามาดูแลคุณภายใน 15 นาทีครับ 😊\n\nขอบคุณที่ไว้วางใจ ScanFood POS ครับ ❤️`;
  } else {
    // นอกเวลาทำการ 00:00 - 08:59
    text = `สวัสดีครับ 🙏 ขอบคุณที่ทักมาหา ScanFood ครับ\n\nตอนนี้อยู่นอกช่วงเวลาทำการ (09:00–24:00)\nทีมงานจะกลับมาตอบคุณตั้งแต่ 9 โมงเช้าเป็นต้นไปนะครับ 😊\n\nหากคุณมีปัญหาหรือคำถาม สามารถพิมพ์ทิ้งไว้ได้เลยครับ\nเราจะรีบตรวจสอบและตอบกลับทันทีเมื่อถึงเวลา\n\nขอบคุณที่ไว้วางใจ ScanFood เสมอครับ ❤️`;
  }

  const message = {
    type: 'text',
    text
  };

  try {
    const response = await axios.post(
      `${LINE_MESSAGING_API}/reply`,
      {
        replyToken,
        messages: [message],
      },
      {
        headers: LINE_HEADER,
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error in reply:', error);
    throw error;
  }
};



// const reply = async (event) => {
//     const userId = event.source.userId;
//     const replyToken = event.replyToken;
//     const shouldSend = await shouldReply(userId);
//     if (!shouldSend) {
//       console.log('Already replied recently. Skipping...');
//       return;
//     }

//     const message = {
//       type: 'text',
//       text: 'สวัสดีครับ ขอบคุณที่ทักเข้ามานะครับ เราได้รับข้อความแล้ว เดี๋ยวแอดมินจะรีบเข้ามาดูแลภายใน 15 นาทีครับ ❤️'
//     };
//     try {
//       const response = await axios.post(
//         `${LINE_MESSAGING_API}/reply`,
//         {
//           replyToken,
//           messages:[message],
//         },
//         {
//           headers: LINE_HEADER,
//         }
//       );
//       return response.data;
//     } catch (error) {
//       console.error('Error in reply:', error);
//       throw error;
//     }
//   };

async function shouldReply(userId) {
  const ref = db.collection('replyControl').doc(userId);
  const doc = await ref.get();

  const now = Date.now();
  const last = doc.exists ? doc.data().lastRepliedAt.toMillis() : 0;

  if (now - last > REPLY_COOLDOWN) {
    await ref.set({ lastRepliedAt: new Date() });
    return true;
  }

  return false;
}

app.get("/Gift", async (req, res) => {
    try {
        // Respond to the original request
        res.status(200).send('คิดถึงคนสวย นะครับ');
    } catch (err) {
        // Log error and respond with error message
        functions.logger.error("function:checkPhoneRegister:error", err);
        res.status(500).send({ error: err });
    }
});

module.exports = app;
