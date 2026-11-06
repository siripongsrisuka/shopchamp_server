const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");


const app = express();
app.use(cors({origin:true}));

const { formatTime } = require("../helpers/functions");

const initialShift = {
    closeBy:'',
    closeCash:'',
    closeComment:'',
    closeDiff:'',
    closeTime:'',
    closeWithDraw:'',
    duringShift:[],
    openBy:'',
    openCash:'',
    openComment:'',
    openDiff:'',
    openTime:'',
    openWithDraw:'',
    shopId:'',
    posId:'',
    currentCash:0,
    status:false, //  เปิดกะ หรือปิดกะ ดูตรงนี้
    lastShiftDate:'20230909', // เอาไว้เริ่มกะใหม่
    shiftCount:0,
    receiptNumber:'', // เอาไว้ fetch ข้อมูล
};

const initialCheckOut = {
  billDate:'',
  currentReward:[],
  dateTime:new Date(),
  manualDiscount:0,
  member:{},
  moneyMustPaid:999,
  normalPoint:0,
  payment:[], 
  pointDiscount:{ point:0, value:0 },
  pointToItem:[],
  posId:'',
  product:[
      // {
      //     name:'ขนมขายดี',
      //     qty:99,
      //     net:999,
      //     totalPrice:999,
      //     tempId:9
      // }
  ], 
  productDiscount:0,
  receiptNumber:1, 
  shopId:'',
  specialPoint:0,
  staff:[],
  timestamp:new Date(), 
  totalQty:1, 
  
  net:999, 
  discount:0,
  fortune:[],
  campaign:[],
  coupon:[],
  change:0, // เงินทอน
  rounding:0,
  cashierId:'',
  cashierName:''
}

function manageSummary({ selectedBill, smartCategory, selectedVoidBill, }){
  
    let thisPayment = []
    let thisProduct = []
    let thisCategory = []
    let thisSelectedQty = selectedBill.length;
    let thisVoidQty = selectedVoidBill.length;
    let saleRate = 0;
    let thisTotalNet = 0;
    let thisTotalPrice = 0;
    let thisRounding = 0;
    let thisTotalChange = 0;
    let thisCampaign = []
    let totalManualDiscount = 0
    let totalPointDiscount = 0
    let totalProductDiscount = 0
    let thisCashier = []
    
  
    for(const { manualDiscount, moneyMustPaid, payment, pointDiscount, product, productDiscount, rounding, campaign = [], 
      change, cashierId, cashierName } of selectedBill){

      let findCashier = thisCashier.find(b=>b.cashierId===cashierId)
      if(findCashier){
        findCashier.amount += Number(moneyMustPaid)
      } else {
        thisCashier.push({ cashierId, cashierName, amount:Number(moneyMustPaid) })
      }
  
      if(rounding){
        thisRounding += Number(rounding)
      }
      if(change){
        thisTotalChange += Number(change)
      }
      if(manualDiscount){
        totalManualDiscount += Number(manualDiscount)
      }
      if(pointDiscount.value){
        totalPointDiscount += Number(pointDiscount.value)
      }
      thisTotalNet += Number(moneyMustPaid)
      totalProductDiscount += Number(productDiscount)
        
      for(const { id, name, discount } of campaign){
        let findCampaign = thisCampaign.find(a=>a.id===id)
        if(findCampaign && findCampaign.id){
          findCampaign.discount += Number(discount)
          findCampaign.qty ++
        } else {
          thisCampaign.push({ name, qty:1, discount:Number(discount), id})
        }
      }
        
  
        for(const a of payment){
          let findPayment = thisPayment.find(b=>b.id===a.id)
          if(findPayment && findPayment.id){
            findPayment.amount += Number(a.amount)-Number(a?.change||0)
            findPayment.qty ++
          } else {
            thisPayment.push({...a,amount:Number(a.amount)-Number(a?.change||0),qty:1})
          }
        }
        if(payment.length===0){
          let findPayment = thisPayment.find(b=>b.id==='noId')
          if(findPayment && findPayment.id){
            findPayment.amount += net
            findPayment.qty ++
          } else {
            thisPayment.push({name:'No Payment Type',amount:net,qty:1,id:'noId'})
          }
        }
        for(const { id, name, qty, totalPrice, category = [] } of product){
          thisTotalPrice += Number(totalPrice)
          let findProduct = thisProduct.find(a=>a.id===id)
          if(findProduct && findProduct.id){
            findProduct.thisQty += qty
            findProduct.thisTotalPrice += Number(totalPrice)
            findProduct.count ++
          } else {
            thisProduct.push({
              id,
              name,
              thisQty:qty, // จำนวนทั้งหมดที่สั่ง
              count:1, // จำนวนครั้งที่สั่งต่อ 1 บิล = 1 ครั้ง
              thisTotalPrice:Number(totalPrice) // ยอดขายทั้งหมด
            })
          }
          if(category.length===0){
              let findCategory = thisCategory.find(a=>a.id==='id') // หมวดหมู่ชั่นที่ 1
              if(findCategory && findCategory.id){
                findCategory.thisQty += qty
                findCategory.thisTotalPrice += Number(totalPrice)
              } else {
                thisCategory.push({
                  id:'id',
                  thisQty:qty,
                  thisTotalPrice:Number(totalPrice),
                  name:'No Category'
                })
              }
          } else {
            let firstCategory = category[0];
            let findCategory = thisCategory.find(a=>a.id===firstCategory) // หมวดหมู่ชั่นที่ 1
            if(findCategory && findCategory.id){
              findCategory.thisQty += qty
              findCategory.thisTotalPrice += Number(totalPrice)
            } else {
              thisCategory.push({
                id:firstCategory,
                thisQty:qty,
                thisTotalPrice:Number(totalPrice),
                name:(smartCategory[0]?.value||[]).find(a=>a.id===firstCategory)?.name||"UnKnow Category",
              })
            }
          }
        }
    }
    let thisTotalCash = thisPayment.find(a=>a.id===1)?.amount || 0
    if(thisSelectedQty>0){
      saleRate = thisTotalNet/thisSelectedQty
    }
    
  
    return {
      thisPayment,
      thisProduct,
      thisCategory,
      thisSelectedQty,
      thisVoidQty,
      saleRate,
      thisTotalNet,
      thisTotalPrice,
      thisRounding,
      thisTotalCash,
      thisTotalChange,
      thisCampaign,
      totalManualDiscount,
      totalPointDiscount,
      totalProductDiscount,
      thisCashier
    }
  };

var db = admin.firestore(); // Initialize Firestore database

app.post("/test", async (req, res) => {
    try{

        const { smartCategory, shiftId } = req.body;

        let billData = []
            const shiftDoc = await db.collection('shift').doc(shiftId).get();
            shiftData = { ...initialShift, ...shiftDoc.data(), id:shiftId }

            if(shiftData.openId){ // เปิดกะแล้ว
                const { status, openTime } = shiftData
                if(status){
                  const checkoutDocs = await db.collection('bill')
                        .where("shiftId", "==", shiftId)
                        .where("dateTime", ">", formatTime(openTime))
                        .select("manualDiscount", "moneyMustPaid", "payment", "pointDiscount", "product", "productDiscount", "change",  "rounding", 
                          "campaign","void","cashierId", "cashierName" )
                        .get();

                        billData = checkoutDocs.docs.map(doc => ({
                            ...initialCheckOut,
                            ...doc.data(),
                            id: doc.id
                        }));
                }
            }
            const selectedBill = billData.filter(a => !a.void);
            const selectedVoidBill = billData.filter(a => a.void);
            const thisSummary = manageSummary({ selectedBill, smartCategory, selectedVoidBill })
      
        functions.logger.info("function:shift:info",{message:"success"});
        res.status(200).send({ shiftData, thisSummary });
    }catch(err){
        functions.logger.error("function:shift:error",err)
        res.status(500).send(err)
    }
});


app.post("/bill", async (req, res) => {
  try{

      const { shopId, smartCategory, startDate, endDate } = req.body;

      let billData = []
      const checkoutDocs = await db.collection('bill')
          .where("shopId", "==", shopId)
          .where('dateTime', '>', new Date(startDate))
          .where('dateTime', '<=', new Date(endDate))
          .orderBy('dateTime', 'desc')
          .select("manualDiscount", "moneyMustPaid", "payment", "pointDiscount", "product", "productDiscount", "change",  "rounding", 
            "campaign","void","cashierId", "cashierName" )
          .get();

      billData = checkoutDocs.docs.map(doc => ({
          ...initialCheckOut,
          ...doc.data(),
          id: doc.id
      }));
      const selectedBill = billData.filter(a => !a.void);
      const selectedVoidBill = billData.filter(a => a.void);
      const thisSummary = manageSummary({ selectedBill, smartCategory, selectedVoidBill })
        
      functions.logger.info("function:summary:info",{message:"Found Registered User"});
      res.status(200).send({ qty:billData.length, thisSummary });
  }catch(err){
      functions.logger.error("function:summary:error",err)
      res.status(500).send(err)
  }
});


module.exports = app;
