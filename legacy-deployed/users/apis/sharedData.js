const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch-commonjs");   // config adjust of "node-fetch" ,for compatible with all javascript,ESM,node version, fetch require for production to cloudfunciton it not like local server It not know the basic commnad "fetch()"


const app = express();
app.use(cors({origin:true}));

const { checkSharedDataGrantUser, checkIfAuthenticated } = require("../middlewares/auth_middleware");
// const distincBarcode = require("./assets/data/distincBarcode.json");
// const distincBarcode = require("./assets/data/reget_barcode_ref.json");
const distincBarcode = require("./assets/data/toFindBarcodeData_20240227.json");
const axios = require("axios");
const env = require("../env.json");





// ######## !!! Can use "GET" method req.body in local server but cannot in production server on firebase nodeJs cloud function.
// ######## It's will show "Error 400 (Bad Request) Your client has issued a malformed or illegal request."
// ######## So must use "POST" method instead (depend on each server environment whether grand/not grant)
// ######## https://stackoverflow.com/questions/3373657/app-engine-400-your-client-has-issued-a-malformed-or-illegal-request

// //  getBill
// app.post("/getBill/:shopId",checkSharedDataGrantUser, async (req, res) => {
//     try{
//         const { shopId } = req.params;

//         let startYmd = Object.hasOwn(req.body,"startYmd") ? new Date(req.body.startYmd) : "";   // 2023-09-23
//         let endYmd = Object.hasOwn(req.body,"endYmd") ? new Date(req.body.endYmd) : "";
//         let utcOffset = Object.hasOwn(req.body,"utcOffset") ? req.body.utcOffset : 7;

//         // let startYmd = new Date("2023-05-07T00:00:00");
//         // let endYmd = new Date("2023-05-07T00:00:00");

//         // let startYmd = new Date("2023-09-23T00:00:00");
//         // let endYmd = new Date("2023-09-23T00:00:00");

//         startYmd.setHours(0);
//         startYmd.setMinutes(0);
//         startYmd.setSeconds(0);
//         startYmd.setMilliseconds(0);
    
//         endYmd.setHours(23);
//         endYmd.setMinutes(59);
//         endYmd.setSeconds(59);
//         endYmd.setMilliseconds(999)
        

//         let data = [] ;
//         await admin.firestore().collection('bill')
//         .where("shopId","==",shopId) 
//         .where("timestamp",">=",new Date(startYmd))
//         .where("timestamp","<=",new Date(endYmd))

//         .get().then((docs)=>{
//             docs.forEach((doc)=>{
//                 // let modfData = doc.data();
//                 // convertFrbTimestampsToDates2(modfData)
//                 // data.push(modfData)


//                 data.push({...doc.data(),id:doc.id})
//             })
//         });

//         convertFrbTimestampsToDates(data,utcOffset);


//         functions.logger.info("function:getBill:info",{message:"Success getBill"});
//         // return res.status(200).send([
//         //     {
//         //         startYmd:startYmd,
//         //         endYmd:endYmd,
//         //         utcOffset:utcOffset,
//         //         length:data.length
//         //     }
//         //     ,...data
//         // ]);
//         return res.status(200).send(data);

//     }catch(err){
//         functions.logger.error("function:getBill:catch",err);
//         res.status(500).send({ message: "Internal Server Error",error:err});
//     }
// });


// //  getProduct
// app.post("/getProduct/:shopId",checkSharedDataGrantUser, async (req, res) => {
//     try{
//         const { shopId } = req.params;

//         let utcOffset = Object.hasOwn(req.body,"utcOffset") ? req.body.utcOffset : 7;

//         let data = [] ;
//         await admin.firestore().collection('product')
//         .where("shopId","==",shopId) 
//         .get().then((docs)=>{
//             docs.forEach((doc)=>{
//                 data.push(doc.data())
//             })
//         });

//         convertFrbTimestampsToDates(data,utcOffset);


//         functions.logger.info("function:getProduct:info",{message:"Success getProduct"});
//         // return res.status(200).send([
//         //     {
//         //         utcOffset:utcOffset,
//         //         length:data.length
//         //     }
//         //     ,...data
//         // ]);
//         return res.status(200).send(data);


//     }catch(err){
//         functions.logger.error("function:getProduct:catch",err);
//         res.status(500).send({ message: "Internal Server Error",error:err});
//     }
// });


// //  getProductCsv
// app.post("/getProductCsv/:shopId",checkSharedDataGrantUser, async (req, res) => {
//     try{
//         const { shopId } = req.params;

//         let utcOffset = Object.hasOwn(req.body,"utcOffset") ? req.body.utcOffset : 7;


//         // shop data ref
//         function findInArray(arr,propertise,value){
//         return arr.find(item=>item[propertise] === value)
//         };

//         let shop = {} ;
//         await admin.firestore().collection('shop')
//         .doc(shopId)
//         .get().then((doc)=>{
//             shop = doc.data();
//         });

//         const arrEasyCategoryRef = shop.smartCategory[0].value;
        

//         let data = [] ;
//         await admin.firestore().collection('product')
//         .where("shopId","==",shopId) 
//         .get().then((docs)=>{
//             docs.forEach((doc)=>{
//                 data.push({...doc.data(),id:doc.id})
//             })
//         });

//         convertFrbTimestampsToDates(data,utcOffset);


//         const modfData = data.map(({name,price,BOM,category},index) => ({
//             id:index+1,
//             name:name,
//             salePrice:price[0].price,
//             isBom:BOM.length > 0 ? 'มี' : 'ไม่มี',
//             category:findInArray(arrEasyCategoryRef,'id',category[0])?.name || 'nonCategory'
//         }))

//         // const modfData = data.map(({id,name},index) => ({
//         //     no:index+1,
//         //     id:id,
//         //     name:name,
//         // }))

//         const fileName = "shopProduct.csv"
//         let csvData = "";
//         const csvFields = Object.keys(modfData[0]);
//         csvData = csvFields.join(",") + "\r\n" ;

//         modfData.forEach((doc) => {
//             csvData += Object.values(doc).join(",") + "\r\n"
//         });


//         functions.logger.info("function:getProductCsv:info",{message:"Success getProduct"});
//         // return res.status(200).send(data);
//         // return res.status(200).send(modfData);
//         res
//             .status(200)
//             .set({
//                 "Content-Type": "text/csv",
//                 "Content-Disposition": `attachment; filename="${fileName}"`,
//             })
//             .send(csvData);


//     }catch(err){
//         functions.logger.error("function:getProductCsv:catch",err);
//         res.status(500).send({ message: "Internal Server Error",error:err});
//     }
// });


// //  getShop
// app.post("/getShop/:shopId",checkSharedDataGrantUser, async (req, res) => {
//     try{
//         const { shopId } = req.params;
//         const { isAdmin } = req;

//         let utcOffset = Object.hasOwn(req.body,"utcOffset") ? req.body.utcOffset : 7;

//         let data = {} ;
//         await admin.firestore().collection('shop')
//         .doc(shopId)
//         .get().then((doc)=>{
//             if (isAdmin === true){
//                 data = doc.data();
//             }else{
//                 const _data = {...doc.data()};  // copy (by spread operator) instead of assign to not effect key of object in original source
//                 delete _data?.humanResource
//                 data = _data;
//             }   
            
//         });

//         convertFrbTimestampsToDates(data,utcOffset);


//         functions.logger.info("function:getShop:info",{message:"Success getShop"});
//         // return res.status(200).send([
//         //     {
//         //         utcOffset:utcOffset,
//         //         length:data.length
//         //     }
//         //     ,...data
//         // ]);
//         return res.status(200).send(data);


//     }catch(err){
//         functions.logger.error("function:getShop:catch",err);
//         res.status(500).send({ message: "Internal Server Error",error:err});
//     }
// });



// getTestSecureData
app.get("/getTestSecureData",checkSharedDataGrantUser,async (req,res)=>{

    console.log("This_is_secure_data");
    return res.status(200).send("This_is_secure_data");
});


// getTestData
app.get("/getTestData",checkIfAuthenticated,async (req,res)=>{

    console.log("Can_get_data");
    return res.status(200).send("Can_get_data");
});

var db = admin.firestore(); // Initialize Firestore database

const initialProduct = {
    barcode:'',
    barcodeStatus:true,
    cashierShow:false,
    category:[],
    consignment:false,
    cost:'',
    delivery:false,
    imageId:'',
    name:'',
    price:'',
    promotion:{
        status:false,
        qty:'',
        price:'',
        startDate:new Date(),
        endDate:new Date(),
    },
    rent:false,
    safetyStock:{
        status:false,
        qty:''
    },
    shopId:'',
    sku:'',
    stock:'',
    unit:'ชิ้น',
    vatExemption:false,
    expReport:[],
    priceLevelStatus:false,
    priceLevel:[],
    pointStatus:true,
    stockCountStatus:true,
    customQtyStatus:false,
    customPriceStatus:false,
    other:[],
    selfImage:false,
    updateTime:new Date(2011, 0, 1, 0, 0, 0, 0)
};

// //  getBill
// // app.post("/getOrder/:shopId",checkSharedDataGrantUser, async (req, res) => {
// app.post("/getOrder/:shopId", async (req, res) => {
//     try{
//         const { shopId } = req.params;
//         const {orderId} = req.body;

//         let startYmd = Object.hasOwn(req.body,"startYmd") ? new Date(req.body.startYmd) : "";   // 2023-09-23
//         let endYmd = Object.hasOwn(req.body,"endYmd") ? new Date(req.body.endYmd) : "";
//         let utcOffset = Object.hasOwn(req.body,"utcOffset") ? req.body.utcOffset : 7;

//         // startYmd.setHours(0);
//         // startYmd.setMinutes(0);
//         // startYmd.setSeconds(0);
//         // startYmd.setMilliseconds(0);
    
//         // endYmd.setHours(23);
//         // endYmd.setMinutes(59);
//         // endYmd.setSeconds(59);
//         // endYmd.setMilliseconds(999)

//         startYmd.setHours(0);
//         startYmd.setMinutes(0);
//         startYmd.setSeconds(0);
//         startYmd.setMilliseconds(0);
    
//         endYmd.setHours(23);
//         endYmd.setMinutes(59);
//         endYmd.setSeconds(59);
//         endYmd.setMilliseconds(999)

        
//         let data = [] ;
//         await admin.firestore().collection('order')
//         .where("shopId","==",shopId) 
//         .where("timestamp",">=",new Date(startYmd))
//         .where("timestamp","<=",new Date(endYmd))

//         .get().then((docs)=>{
//             docs.forEach((doc)=>{
//                 data.push({...doc.data(),id:doc.id})
//             })
//         });

//         convertFrbTimestampsToDates(data,utcOffset);


//         functions.logger.info("function:getOrder:info",{message:"Success getOrder"});
//         // return res.status(200).send([
//         //     {
//         //         startYmd:startYmd,
//         //         endYmd:endYmd,
//         //         utcOffset:utcOffset,
//         //         length:data.length
//         //     }
//         //     ,...data
//         // ]);
//         return res.status(200).send(data);

//     }catch(err){
//         functions.logger.error("function:getOrder:catch",err);
//         res.status(500).send({ message: "Internal Server Error",error:err});
//     }
// });



// // getBarcodeRef
// app.post("/getBarcodeRef/:shopId", async (req, res) => {
app.post("/getBarcodeRef", async (req, res) => {
    try{
        const { startBarcodeRec,endBarcodeRec } = req.body;

        async function fetchDataInBatches(barcodeArray, batchSize = 10,startBarcodeRec,endBarcodeRec) {
            const results = [];
            const allBatchInput = [];

            // const barcodeString = barcodeArray.map(({barcode})=>(barcode)).slice(106).slice(0,500)
            // const barcodeString = barcodeArray.map(({barcode})=>(barcode)).slice(106).slice(1 -1,500 -1)

            console.log('startBarcodeRec -1')
            console.log(startBarcodeRec-1)
            console.log("endBarcodeRec")
            console.log(endBarcodeRec)
            // console.log('indexOf_8854923212307')
            // console.log(barcodeArray.findIndex(objBarcode => objBarcode?.barcode === "8854923212307"))      // 15804 , 15804 + 106 = 15910

            // return 

            const barcodeString = barcodeArray.map(({barcode})=>(barcode)).slice(startBarcodeRec -1,endBarcodeRec)
            // const barcodeString = barcodeArray.map(({barcode})=>(barcode)).slice(106).slice(startBarcodeRec -1,endBarcodeRec)
            // const barcodeString = barcodeArray.map(({barcode})=>(barcode)).slice(startBarcodeRec -1,startBarcodeRec)


            console.log('barcodeString')
            console.log(barcodeString)  

            console.log(`allInput : ${barcodeString.length}`);

            for (let i = 0; i < barcodeString.length; i += batchSize) {
                const batch = barcodeString.slice(i, i + batchSize);

                console.log(`batch_no : ${Number(Number(i/batchSize) + 1)}`)


                // // !!! asynchonus_fetch_batch, still not complete result so not use !!!
                // const batchResults = await Promise.all(batch.map(barcode => fetchData(barcode)));
                // results.push(...batchResults.filter(e => e != null));

                // synchonus_fetch_batch
                // for (let [index2, barcode] of batch){
                let index2 = 0;
                for (barcode of batch){
                    // console.log(`barcode_of_batch`)
                    // console.log(barcode)
                
                    const batchResults = await fetchData(barcode);
                    if (batchResults) results.push(batchResults);

                    console.log(`barcode_no : ${Number(Number(i) + Number(Number(index2)+1))}`)
                    console.log(`${barcode} batchResults : ${Number(Number(index2)+1)}`)
                    console.log(batchResults)

                    index2 += 1
                    // await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before retrying
                }

                allBatchInput.push(batch);
            }

            // console.log('allBatchInput')
            // console.log(allBatchInput)
        
            return results;
        }
        
        async function fetchData(barcode,retryCount = 3) {

            // console.log('fetcData_barcode')
            // console.log(barcode)


            const apiReq = {
              method: 'POST',
              url: `https://rms.cdar.nielseniq.com/barter-backend-service/btr/api/barcodeLookup`,
              headers: {
                  "Authorization" : `Bearer ${env.niq_BarcodeLookup.token}`,
                  "x-region-id":env.niq_BarcodeLookup["x-region-id"],
                  "x-vendor-id":env.niq_BarcodeLookup["x-vendor-id"],
                  "x-store-id":env.niq_BarcodeLookup["x-store-id"],
                  "x-auth-user-type":env.niq_BarcodeLookup["x-auth-user-type"]
              },
              data: { // ("body")
                  country: "th",
                  barcode: barcode

                  // from replacement feedback
                //   barcode:'8859003203138'

                  // from templateStock
                // barcode:'8850250012856'

                //   barcode: '1234567890123'
                //   barcode: "8850029022949"    // in niq

                // barcode:'95502489',

                // barcode:"8855237130022"
                // barcode:"8855239130509"
                // barcode:"8855239140010"
                // barcode:"8855261000014"
                // barcode:"8855261000021"
                // barcode:"8855277000022"
                // barcode:"8855286000013"
                // barcode:"8855286000020"
                // barcode:"8855286000037"
                // barcode:"8855286000044"
                // barcode:"8855286000112"

                // // test barcode that strong look has ref
                //   barcode:"8854923212307"
                // barcode:"8857107232047"
                // barcode : "8857107980801"
                // barcode:"8857123060037"
                // barcode:"8858882901906"
                // barcode:"8858891301537"
                // barcode:"8858960905093"



                //   barcode: "8850029022949"    // in niq
                  // barcode: "18850267118227"   // not in niq
              }
            };
            
            // while(retryCount > 0){
                try{
                    const response = await axios.request(apiReq);
                    if (response.status === 200){
                        if(response?.data?.data) return response?.data?.data
                    }else {
            
                    }
                }catch(err){
                    console.error(`Error_fetching_data_for_barcode_${barcode}: ${err}`);
                    retryCount -= 1;
                    // if(retryCount > 0){
                    //     console.log(`Retrying... attempts left: ${retryCount}`);
                    //     await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before retrying
                    // }else{
                    //     functions.logger.error(`function:getBarcodeRef:getBardcodeAPIRef:Failed_to_fetch_data_for_barcode_${barcode}_after_several_attempts.:catch`,err);
                    //     res.status(500).send({ message:`getBarcodeRef:getBardcodeAPIRef:Failed_to_fetch_data_for_barcode_${barcode}_after_several_attempts.:Internal Server Error`,error:err});                        
                    // }

                    functions.logger.error(`function:getBarcodeRef:getBardcodeAPIRef:Failed_to_fetch_data_for_barcode_${barcode}_after_several_attempts.:catch`,err);
                    res.status(500).send({ message:`getBarcodeRef:getBardcodeAPIRef:Failed_to_fetch_data_for_barcode_${barcode}_after_several_attempts.:Internal Server Error`,error:err});   
                }            
            // }
        

        }

        // const barcodeRefList = await getBardcodeAPIRef(distincBarcode)
        const barcodeRefList = await fetchDataInBatches(distincBarcode,10,startBarcodeRec,endBarcodeRec);

        // console.log('barcodeRefList')
        // console.log(barcodeRefList)

        const modfData = barcodeRefList.map(({
        // const modfData = barcodeRefList.slice(0,1).map(({
            id,
            categoryId,
            categoryName,
            barcode,
            description,
            manufacturer,
            brand,
            volume,
            packageType,
            pnua
        },index) => ({
            id:id || '',
            categoryId:categoryId || 0,
            categoryName:categoryName || '',
            barcode:barcode || '',
            description:description || '',
            manufacturer:manufacturer || '',
            brand:brand || '',
            volume:volume || '',
            packageType:packageType || '',
            pnua:pnua ||  ''
        }))


        const fileName = `barcodeRef_${startBarcodeRec}-${endBarcodeRec}.csv`
        let csvData = "";

        if(modfData.length >0){
            const csvFields = Object.keys(modfData[0]);
            csvData = csvFields.join(",") + "\r\n" ;

            modfData.forEach((doc) => {
                const cleanedValues = Object.values(doc).map(value => 
                    typeof value === 'string' ? value.replace(/[\n\r",]/g, '') : value
                );
                csvData += cleanedValues.join(",") + "\r\n";
            });            
        }



        functions.logger.info("function:getBarcodeRef:info",{message:"Success getProduct"});
        // return res.status(200).send(data);
        // return res.status(200).send(modfData);
        return res
            .status(200)
            .set({
                "Content-Type": "text/csv",
                "Content-Disposition": `attachment; filename="${fileName}"`,
            })
            .send(csvData);

        // return res.status(200).send(barcodeRefList);



    }catch(err){
        functions.logger.error("function:getBarcodeRef:catch",err);
        res.status(500).send({ message: "Internal Server Error",error:err});
    }
});


//  addStockByTemplate
// // // // ========================= fontEnd =========================
// import { shopchamAPI, shopchamTestAPI } from '../Utility/api';
// import firebaseAuth from '@react-native-firebase/auth';


// const { shop } = useSelector((state) => state.shop);
// const { stocks } = useSelector((state) => state.stock);
// const barcodeList = [];
// stocks.forEach(stock => {
//   barcodeList.push(stock?.barcode)
// })


// // let fbrIdToken  =  
// const frbGetIdToken = () => {
//   const promise = new Promise(async (resolve,reject) => {
//     try{
//       const authToken = await firebaseAuth().currentUser.getIdToken(true);
//       // const authToken = await firebaseAuth().currentUser.getIdToken(false);    // !!! will use for better speeed, when has a trustable solution to handle expire !!!
      
//       // fbrIdToken = authToken;
//       resolve(authToken);

//     }catch(err){
//       console.log(err);
//       reject(err);
//     }    
//   });

//   return promise;
// }

// async function frbRefreshIdToken(){
//   fbrIdToken = await firebaseAuth().currentUser.getIdToken(true);
// }

// async function addStockByTemplate(shopId = '', id = 0, barcode = [], docId = '') {  // update tag to all same external_user_id in all player of onesignal
//   try{
//     const authToken = await frbGetIdToken();
    
//     // const { status,data:resData } = await shopchamTestAPI.post(
//     const { status,data:resData } = await shopchamAPI.post(
//       "/sharedData/addStockByTemplate/",
//       {shopId, id, barcode, docId},
//       {
//         headers: {
//           Authorization: `Bearer ${authToken}`,
//         },
//       }
//     );

//     if(status === 200){
//       console.log('success_addStockByTemplate');
//       console.log('resData.length')
//       console.log('success_addStockByTemplate with '+resData.length)
//     }


//   }catch(err){
//     console.log('catch')
//     console.log('err')
//     console.log(err)


//     // if (err.response && err.response.status === 401) {
//     //   await frbRefreshIdToken();
//     //   return addStockByTemplate(shopId, id, barcode, docId);
//     // } else {
//     //   throw err;
//     // }

//   }

// }
// // // // ========================= End of fontEnd =========================

// // // backEnd

const categorys = [
    {aboveId:[],level:1,id:'AX001', name:'เครื่องดื่ม'},
    {aboveId:[],level:1,id:'AX002', name:'อาหารแห้ง'},
    {aboveId:[],level:1,id:'AX003', name:'อาหารสด'},
    {aboveId:[],level:1,id:'AX004', name:'ยาสามัญประจำบ้าน'},
    {aboveId:[],level:1,id:'AX005', name:'แอลกอฮอร์และบุหรี่'},
    {aboveId:[],level:1,id:'AX006', name:'ขนมและลูกอม'},
    {aboveId:[],level:1,id:'AX007', name:'นมและโยเกิร์ต'},
    {aboveId:[],level:1,id:'AX008', name:'ของใช้ในครัวเรือน'},
    {aboveId:[],level:1,id:'AX009', name:'ไอศครีม'},
    {aboveId:[],level:1,id:'AX010', name:'ไอทีและมือถือ'},
    {aboveId:[],level:1,id:'AX011', name:'สินค้าเกษตร'},
    {aboveId:[],level:1,id:'AX012', name:'สัตว์เลี้ยง'},
    {aboveId:[],level:1,id:'AX013', name:'ไฟฟ้าและประปา'},
    {aboveId:[],level:1,id:'AX014', name:'เครื่องเขียน'},
    {aboveId:[],level:1,id:'AX015', name:'สุขภาพและความงาม'},
    {aboveId:[],level:1,id:'AX016', name:'ครัวและเครื่องปรุงรส'},
    {aboveId:[],level:1,id:'AX017', name:'อื่นๆ'},
];

app.post("/test", async (req, res) => {
    const { shopId, id,  docId } = req.body;

    try {
        // Use an object lookup instead of a switch statement
        const typeMap = {
            0: ['10'],
            1: ['500'],
            2: ['1000'],
            3: ['1500', '1501'],
            4: ['2001', '2002'],
            5: ['3000', '3001', '3002'],
            6: ['4000', '4001', '4002', '4003']
        };

        const arr = typeMap[id] || ['10'];

        // Fetch shop document and handle smartCategory
        const shopDoc = await db.collection('shop').doc(docId).get();
        const { smartCategory = [] } = shopDoc.data() || {};
        // let OldBarcode = []
        // const stockDocs = await db.collection('stock')
        //         .where("shopId", "==", docId)
        //         .select("barcode")
        //         .get();

        //         OldBarcode = stockDocs.docs.map(doc => ({
        //             ...doc.data(),
        //         }));
        const stockDocs = await db.collection('stock')
            .where("shopId", "==", docId)
            .select("barcode")
            .get();
        
        const OldBarcode = stockDocs.docs.map(doc => doc.get("barcode"));  // Extract barcode directly
        let newCategory = smartCategory;
        const firstLevel = smartCategory.find(a => a.level === 1)?.value || [];

        if (firstLevel.length > 0) {
            const firstLevelIds = new Set(firstLevel.map(a=>a.id));
            const newFirstLevel = [...firstLevel, ...categorys.filter(a => !firstLevelIds.has(a.id))];

            newCategory = smartCategory.map(item =>
                item.level === 1 ? { level: 1, value: newFirstLevel } : item
            );
        } else {
            newCategory = [{ level: 1, value: categorys }];
        }

        await db.collection('shop').doc(docId).update({ smartCategory: newCategory });

        const oldBarcodeIds = new Set(OldBarcode);
        const cashierShow = id === 0; // Display free items to cashier

        // Fetch section stock in one go
        const sectionDocs = await db.collection('masterSectionStock')
            .where('type', 'in', arr)
            .get();

        // Extract and transform products efficiently
        const products = sectionDocs.docs.flatMap(doc => doc.data().products)
            .reduce((acc, { barcode, category, cost, imageId, name, price, unit }) => {
                if (!oldBarcodeIds.has(barcode)) {
                    acc.push({
                        ...initialProduct,
                        shopId,
                        category,
                        cost: Number(cost),
                        imageId,
                        name,
                        price: Number(price),
                        unit,
                        barcode,
                        stock: 0,
                        cashierShow
                    });
                }
                return acc;
            }, []);

        // Firestore batch processing in parallel
        const batchSize = 500;
        const batchPromises = [];

        for (let i = 0; i < products.length; i += batchSize) {
            const batch = db.batch();
            products.slice(i, i + batchSize).forEach(product => {
                const newProductRef = db.collection('stock').doc();
                batch.set(newProductRef, {
                    ...product,
                    updateTime: admin.firestore.FieldValue.serverTimestamp()
                });
            });

            batchPromises.push(batch.commit());
        }

        await Promise.all(batchPromises);

        // Send push notification
        await sendPush({
            shopId,
            heading: `อัปเดตรายการสินค้า`,
            content: `เพิ่มสินค้า ${products.length} รายการเสร็จสิ้นแล้วค่ะ`,
        });

        res.status(200).send('success');
    } catch (err) {
        functions.logger.error("function:sharedData/test:catch:error", err);
        res.status(500).send({ message: "catch: Internal Server Error", errors: err });
    }
});

app.post("/addStockByTemplate",checkIfAuthenticated, async (req, res) => {
    const { shopId, id, barcode:OldBarcode, docId } = req.body;

    let operationStatus = [
        { step: 'fetchTemplateStock', status: 'pending', details: null } ,
        { step: 'batchAddStock', status: 'pending', details: [] },
        { step: 'transactionUpdateCategory', status: 'pending', details: null }, // details as an array to track each batch
        { step: 'pushNotificationToClient', status: 'pending', details: null } ,
    ];

 

    const categorys = [
        {aboveId:[],level:1,id:'AX001', name:'เครื่องดื่ม'},
        {aboveId:[],level:1,id:'AX002', name:'อาหารแห้ง'},
        {aboveId:[],level:1,id:'AX003', name:'อาหารสด'},
        {aboveId:[],level:1,id:'AX004', name:'ยาสามัญประจำบ้าน'},
        {aboveId:[],level:1,id:'AX005', name:'แอลกอฮอร์และบุหรี่'},
        {aboveId:[],level:1,id:'AX006', name:'ขนมและลูกอม'},
        {aboveId:[],level:1,id:'AX007', name:'นมและโยเกิร์ต'},
        {aboveId:[],level:1,id:'AX008', name:'ของใช้ในครัวเรือน'},
        {aboveId:[],level:1,id:'AX009', name:'ไอศครีม'},
        {aboveId:[],level:1,id:'AX010', name:'ไอทีและมือถือ'},
        {aboveId:[],level:1,id:'AX011', name:'สินค้าเกษตร'},
        {aboveId:[],level:1,id:'AX012', name:'สัตว์เลี้ยง'},
        {aboveId:[],level:1,id:'AX013', name:'ไฟฟ้าและประปา'},
        {aboveId:[],level:1,id:'AX014', name:'เครื่องเขียน'},
        {aboveId:[],level:1,id:'AX015', name:'สุขภาพและความงาม'},
        {aboveId:[],level:1,id:'AX016', name:'ครัวและเครื่องปรุงรส'},
        {aboveId:[],level:1,id:'AX017', name:'อื่นๆ'},
    ];
    
    try{
        let data = [] ;
        let arr = [];

        switch (id) {
            case 0:
                arr = ['10']
                break;
            case 1:
                arr = ['500']
                break;
            case 2:
                arr = ['1000']
                break;
            case 3:
                arr = ['1500','1501']
                break;
            case 4:
                arr = ['2001','2002']
                break;
            case 5:
                arr = ['3000','3001','3002']
                break;
            case 6:
                arr = ['4000','4001','4002','4003']
                break;
            default:
                arr = ['10']
        }

        const oldBarcodeIds = new Set(OldBarcode);
        const cashierShow = id === 0 ? true : false ; // รายการฟรี 10 รายการ ให้แสดงที่ cashier
        // 1. fetchTemplateStock


        await db.collection('masterSectionStock').where('type','in',arr).get().then((qsnapshot)=>{
            qsnapshot.forEach((doc)=>{
                doc.data()?.products.forEach( productRec => {
                    const { barcode, category, cost, imageId, name, price, unit } = productRec;

                    if(!oldBarcodeIds.has(barcode)){
                        data.push({
                            ...initialProduct,
                            shopId,
                            category,
                            cost:Number(cost),
                            imageId,
                            name,
                            price:Number(price),
                            unit,
                            barcode,
                            stock:0,
                            cashierShow
                        })
                    }
                })
            })
        });

        operationStatus[0].status = 'success';

        // 2. batchAddStock
        const batchSize = 500;
        const newProducts = [];
        for (let i = 0; i < data.length; i += batchSize) {
            const batch = admin.firestore().batch();
            const currentBatch = data.slice(i, i + batchSize);
            let batchIndex = i / batchSize;

            currentBatch.forEach((product) => {
                const newProductRef = admin.firestore().collection('stock').doc();
                batch.set(newProductRef, {
                    ...product,
                    updateTime: admin.firestore.FieldValue.serverTimestamp()
                });

                newProducts.push({ id: newProductRef.id, ...product });
            });

            // Commit each batch
            // await batch.commit();

            try {
                await batch.commit();
                operationStatus[1].details.push({ batchIndex, status: 'success' });
            } catch (err) {
                console.error(`Batch ${batchIndex} failed:`, err);
                operationStatus[1].status = 'failed';
                operationStatus[1].details.push({ batchIndex, status: 'failed', error: err.message });

                // // There has 2 option to return execution
                // # option1 , return execution in this scope
                functions.logger.error(`function:addStockByTemplate:batchAddStock:catch:shopId:${shopId}`,err);
                return res.status(500).send({ 
                    message: "Internal Server Error",
                    error:err,
                    operationStatus:operationStatus[1],
                    data:{shopId:shopId},
                });

                // # option2 , return execution at outside catch scope by throw new Error
                // throw new Error(`Stopping due to failure in batch ${batchIndex} (on ${i}/${data.length})`);
            }

        }
        if (operationStatus[1].status === 'pending') {
            operationStatus[1].status = 'success'; // All batches succeeded
        }

        // 3. transactionUpdateCategory
        const shopRef = admin.firestore().collection("shop").doc(docId)
        admin.firestore().runTransaction(async tx => {
            return tx.get(shopRef).then(async doc =>{
                const { smartCategory } = doc.data();
                let newCategory = [];
                let findFirstLevel = smartCategory.filter(a=>a.level===1)
                if(findFirstLevel && findFirstLevel.level){
                    let newValue = [...findFirstLevel.value]
                    for(const item of categorys){
                        if(!newValue.some(a=>a.id===item.id)){
                            newValue.push(item)
                        }
                    }
                    newCategory = smartCategory.map((item)=>{
                        return item.level===1
                            ?{level:1,value:newValue}
                            :item
                    })

                } else { // แปลว่าเป็น array ว่าง
                    newCategory = [{level:1,value:categorys}]
                }

                await tx.update(shopRef,{smartCategory:newCategory})
            })
        });
        operationStatus[2].status = 'success'; // Transaction succeeded

        // 4. pushNotificationToClient
        // `เพิ่มสินค้า ${data.length} รายการเสร็จสิ้น กรุณาปัดแอพออก และเข้าใหม่อีกครั้งเพื่ออัปเดตรายการสินค้า`   //`เพิ่มสินค้า 500 รายการเสร็จสิ้น กรุณาปัดแอพออก และเข้าใหม่อีกครั้งเพื่ออัปเดตรายการสินค้า`
        // operationStatus[3].status = 'success';

        await sendPush({
            shopId,
            heading:`อัปเดตรายการสินค้า`,
            content:`เพิ่มสินค้า ${data.length} รายการเสร็จสิ้น กรุณาปัดแอพออก และเข้าใหม่อีกครั้งเพื่ออัปเดตรายการสินค้า`,
        });




        functions.logger.info("function:addStockByTemplate:info",{message:"Success addStockByTemplate"});
        return res.status(200).send(data);    // The stock that has added to shop


    }catch(err){
        // functions.logger.error("function:addStockByTemplate:catch",err);
        // res.status(500).send({ message: "Internal Server Error",error:err});

        console.error('Error in operation:', err);
        // Update status based on where the error occurred
        if (operationStatus[0].status === 'pending') {
            operationStatus[0].status = 'failed';
            operationStatus[0].details = err.message;

            functions.logger.error(`function:addStockByTemplate:fetchTemplateStock:catch:shopId:${shopId}`,err);
            return res.status(500).send({ 
                message: "Internal Server Error",
                error:err,
                operationStatus:operationStatus[0],
                data:{shopId:shopId},
            });
        }
        // // No else for operationStatus[1] needed, as batch failures are handled in their catch block

        // // Rollback or log based on operationStatus
        // if (operationStatus[1].status === 'failed') {
        //     // // There is has 2 option

        //     // # 1 only end execution
        //     // an Erorr text form "throw new Error()"
        //     console.error('Error in operation:', err);
        //     console.log(err.message); 

        //     functions.logger.error(`function:addStockByTemplate:batchAddStock:catch:shopId:${shopId}`,err);
        //     return res.status(500).send({ 
        //         message: "Internal Server Error",
        //         error:err,
        //         operationStatus:operationStatus[1],
        //         data:{shopId:shopId},
        //     });

        //     // # 2 rollback data by manual function, !! may not complete and has error
        //     // await rollbackAddedDocuments(addedDocRefs);
        // }


        if (operationStatus[2].status === 'pending') {
            operationStatus[2].status = 'failed';
            operationStatus[2].details = err.message;

            functions.logger.error(`function:addStockByTemplate:transactionUpdateCategory:catch:shopId:${shopId}`,err);
            return res.status(500).send({ 
                message: "Internal Server Error",
                error:err,
                operationStatus:operationStatus[2],
                data:{shopId:shopId},
            });
        }

        // optional
        if (operationStatus[3].status === 'pending') {
            operationStatus[3].status = 'failed';
            operationStatus[3].details = err.message;

            functions.logger.error(`function:addStockByTemplate:pushNotificationToClient:catch:shopId:${shopId}`,err);
            return res.status(500).send({ 
                message: "Internal Server Error",
                error:err,
                operationStatus:operationStatus[3],
                data:{shopId:shopId},
            });
        }

        // Further error handling or logging based on operationStatus


        functions.logger.error("function:addStockByTemplate:catch",err);
        return res.status(500).send({ message: "Internal Server Error",error:err});
    }
});

app.post("/testSupplementPushNoti",checkIfAuthenticated, async (req, res) => {
    const { shopId, id, barcode:OldBarcode, docId } = req.body;

    try{
        const { status,objRes }  = await sendPush({
            shopId,
            heading:`อัปเดตรายการสินค้า`,
            content:`เพิ่มสินค้า ${10} รายการเสร็จสิ้น กรุณาปัดแอพออก และเข้าใหม่อีกครั้งเพื่ออัปเดตรายการสินค้า`,
        });

        if (status === 200){
            functions.logger.info("function:testSupplementPushNoti:info",{message:"Success testSupplementPushNoti"});
            res.status(200).send(objRes);

        }else {
            functions.logger.error("function:testSupplementPushNoti:error",objRes);
            res.status(status).send({message:"Not 200",objRes:objRes});
            
        }
    }catch(err){
        functions.logger.error("function:testSupplementPushNoti:catch:error",err);
        res.status(500).send({message:"catch:Internal Server Error",errors:err});
    }



});



// // ================================== Utility Function =====================================


// async function rollbackAddedDocuments(addedDocRefs) {
//     // Logic to rollback added documents in batches
//     for (const docRef of addedDocRefs) {
//         try {
//             await docRef.delete();
//         } catch (rollbackError) {
//             console.error('Rollback failed for document:', docRef.id, rollbackError);
//         }
//     }
// }








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

async function sendPush(dataSet){
    try{
        const androidChannelIds = {
            urgent:'30487017-ba42-4bc2-b2a7-9bf675015b02',   // urgent => show on any app foreground (heading notification), vibration/sound/LED, icon on status bar, notification drawer
            high:'80c6547c-e13f-42cb-adac-edad9697f783',  // high => vibration/sound/LED, icon on status bar, notification drawer
            medium:'9579e681-0a80-4091-b411-242f9a996f7a',  // medium => icon on status bar, notification drawer
            low:'85c132d0-ab54-45bf-85cd-2cd5ab529ae4', // low =>   notification drawer
            updateShopStatus:'3dff5b91-63de-4d7f-8533-5963265de285',
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
                    { field: "tag",key: "shopId",relation:"=",value: config?.shopId}
                ]     
            }
        };


        // API like command
        let {heading,content,big_picture,small_icon,large_icon,url,data:pushData,campaignName,objTargerUserCondition,android_channel_id,priority,enable_frequency_cap} = {...onesignalDefault,...objSendPush};

        heading = heading ? heading : 'heading';
        content = content ? content : `เพิ่มสินค้า ${data.length} รายการเสร็จสิ้น กรุณาปัดแอพออก และเข้าใหม่อีกครั้งเพื่ออัปเดตรายการสินค้า`;
        // big_picture = big_picture ? big_picture : 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSKr5wT7rfkjkGvNeqgXjBmarC5ZNoZs-H2uMpML8O7Q4F9W-IlUQibBT6IPqyvX45NOgw&usqp=CAU';
        big_picture = big_picture ? big_picture : '';
        small_icon = small_icon ? small_icon : '';
        large_icon = large_icon ? large_icon : '';
        url = url ? url : '';
        pushData = pushData ? pushData : {abc: 123, foo: 'bar', event_performed: true, amount: 12.1} ;
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


// // ================================== End of Utility Function =====================================


module.exports = app;