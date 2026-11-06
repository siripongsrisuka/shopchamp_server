async function printReceipt(netWorkDeviceList,objShop,objBill){
// async function printReceipt(objShop,objBill){
// async function printReceipt(){

  try{
    const escpos = require('escpos');
    escpos.Network = require('escpos-network');

    const {
      receipt:{
        receipt:{
          header,
          footer
        },
        headerImage:{imageId}
      },

    } = objShop;
    const {
      receiptType,  // // 'normal' || 'void' || 'reprint'
      timestamp,receiptNumber,
      staff:{name:staffName},
      product,
      totalQty,subTotal,serviceChargeValue,net,beforeVat,vatAmount,
      payment
    } = objBill;

    const allDeviceList = [...netWorkDeviceList];

    // const imagePath = 'https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/headerReceipt%2F5ab2fe25-a3d8-488c-a275-0a8a36b3d31020230507194531.JPEG?alt=media&token=28b309cc-990b-4b4c-a638-2c2476180c1c'

    allDeviceList.forEach(device =>{
      const objDevice = new escpos.Network(device);

      // escpos.Image.load(objShop.receipt.headerImage.imageId, function(image){
      escpos.Image.load(imageId, function(image){
        objDevice.open(async (err)=>{
          if(err){  // handle error
            return
          }
          const options = { encoding: "Thai",lineWidth: 32 /* default */ }
          const printer = new escpos.Printer(objDevice, options);

          if(['void','reprint'].includes(receiptType)){
            printer
              .align('CT')
              .size(1, 1)
              .text(receiptType)
              .text('')
          }
          printer
            .align('CT')
            .image(image, 'd24')
          printer
            .size(0, 0)
            // .text(objShop.receipt.header)
            .text(header)
            .align('LT')
            .text('DATE '+stringDateTimeReceipt(timestamp))
            .text('RECEIPT NO. '+receiptNumber)
            .text('CASHIER : '+staffName)
            .drawLine()
          printer  
            .align('LT')
            .size(0, 0)
          // for(i=1;i <= 3;i++){
          //   printer
          //     .tableCustom(
          //       [
          //         { text:"1x เมื่ยงปลาทอด นครปฐม องค์พระ ไก่ไข่ควายงู อุอู ดีดี่ดี้ดี๊ดี๋ สุ่โค้ยย", align:"LEFT",width:0.7},
          //         { text:"230.00", align:"RIGHT",width:0.3},
          //       ],
          //     )          
          // }
          for(const item of product){
            printer
              .tableCustom(
                [
                  { text:(item.qty + (item?.diffQty || 0)).toString()+"x  " +item.name, align:"LEFT",width:0.7},
                  // { text:item.totalPrice.toFixed(2), align:"RIGHT",width:0.3},
                  { text:item.totalPrice.toFixed(2), align:"RIGHT",width:0.3},
                ],
              )
              if(item.option.length > 0){
                printer
                  .tableCustom(
                    [
                      { text:'   '+item.option.join(' / '), align:"LEFT"},
                      // { text:item.totalPrice.toFixed(2), align:"RIGHT",width:0.3},
                    ],
                  )
              }
              if(item.addOn){
                printer
                  .tableCustom(
                    [
                      { text:'   '+item.addOn, align:"LEFT"},
                    ],
                  )
              }
          }
          printer
            .drawLine()
            .align('LT')
            .text('item : '+totalQty.toString())
            .tableCustom(
              [
                { text:"Subtotal:", align:"RIGHT",width:0.66},
                { text:subTotal.toFixed(2), align:"RIGHT",width:0.33},
              ],
            )
            .tableCustom(
              [
                { text:`Service Charge(${objBill.serviceChargeValue.toString()}%):`, align:"RIGHT",width:0.66},
                { text:serviceChargeValue.toFixed(2), align:"RIGHT",width:0.33},
              ],
            )
            if(vatType === "Include"){
              printer
                .tableCustom(
                  [
                    { text:"Total:", align:"RIGHT",width:0.66,style:'B'},
                    { text:net.toFixed(2), align:"RIGHT",width:0.33,style:'B'},
                  ],
                )
                .tableCustom(
                  [
                    { text:"Before VAT:", align:"RIGHT",width:0.66},
                    { text:beforeVat.toFixed(2), align:"RIGHT",width:0.33},
                  ],
                )
                .tableCustom(
                  [
                    { text:`VAT(${vatValue.toString()}%):`, align:"RIGHT",width:0.66},
                    { text:vatAmount.toFixed(2), align:"RIGHT",width:0.33},
                  ],
                )
                .tableCustom(
                  [
                    { text:"Amount Net:", align:"RIGHT",width:0.66,style:'B'},
                    { text:net.toFixed(2), align:"RIGHT",width:0.33,style:'B'},
                  ],
                )
            }
            if(vatType === "Exclude"){
              printer
                .tableCustom(
                  [
                    { text:"Before VAT:", align:"RIGHT",width:0.66},
                    { text:beforeVat.toFixed(2), align:"RIGHT",width:0.33},
                  ],
                )
                .tableCustom(
                  [
                    { text:`VAT(${vatValue.toString()}%):`, align:"RIGHT",width:0.66},
                    { text:vatAmount.toFixed(2), align:"RIGHT",width:0.33},
                  ],
                )
                .tableCustom(
                  [
                    { text:"Total:", align:"RIGHT",width:0.66,style:'B'},
                    { text:net.toFixed(2), align:"RIGHT",width:0.33,style:'B'},
                  ],
                )
            }
            for(const item of payment){
              printer
                .tableCustom(
                  [
                    { text:item.name+":", align:"RIGHT",width:0.66},
                    { text:item.amount, align:"RIGHT",width:0.33},
                  ],
                )  
            }
          printer
            .text('')
            .align('CT')
            .text(footer)
            .text('')
            printer.flush().raw('1b 70 01 10 fa').flush() // open drawer
            printer
            // .cut()   // full cut
            .cut(true)  // partial cut
            .close()

        })
      })

    });
    
  }catch(err){
  //   rn_bridge.channel.send("Error: " + JSON.stringify(err) + " => " + err.stack );
  }
  
}
  
  
  async function printTotalOrder(netWorkDeviceList,objOrder){
    // async function printOrder(){
    try{
      const escpos = require('escpos');
      escpos.Network = require('escpos-network');
  
      const {
        channel, // temp data
        timestamp,
        product,
      } = objOrder;
  
      const allDeviceList = [...netWorkDeviceList];
  
  
      allDeviceList.forEach(async (device)=>{
        const objDevice = new escpos.Network(device);
  
        objDevice.open(async (err)=>{
          if(err){  // handle error
            return
          }
  
          const options = { encoding: "Thai",lineWidth: 32 /* default */ }
          const printer = new escpos.Printer(objDevice, options);
  
          // print full order
          printer
            .size(1, 1)
            .align('LT')
            .text(channel)   // 'Table:'+'1'
            .size(0,0)
            .text('')
            .text('Time '+stringDateTimeReceipt(timestamp))
            .drawLine()  
            for(const item of product){
              printer.text((item.qty + (item?.diffQty || 0)).toString()+"x  " +item.name)
              if(item.option.length > 0){
                printer
                  .tableCustom(
                    [
                      { text:'   '+item.option.join(' / '), align:"LEFT"},
                    ],
                  )
              }
              if(item.addOn){
                printer
                  .tableCustom(
                    [
                      { text:'   '+item.addOn, align:"LEFT"},
                    ],
                  )
              }
            }
          printer
            .drawLine()
            .text('')
            printer
            .cut(true)  // partial cut
            .close()  
  
        })
  
      });
    }catch(err){
    //   rn_bridge.channel.send("Error: " + JSON.stringify(err) + " => " + err.stack );
    }
      
  }
  
  
  async function printItemOrder(netWorkDeviceList,objOrder){
    // async function printOrder(){
    try{
      const escpos = require('escpos');
      escpos.Network = require('escpos-network');
  
      const {
        channel, // temp data
        timestamp,
        product,
      } = objOrder;
  
      const allDeviceList = [...netWorkDeviceList];
  
      allDeviceList.forEach(async (device)=>{
        const objDevice = new escpos.Network(device);
  
        objDevice.open(async (err)=>{
          if(err){  // handle error
            return
          }
  
          const options = { encoding: "Thai",lineWidth: 32 /* default */ }
          const printer = new escpos.Printer(objDevice, options);
  
          // print each item in order
          for(const item of product){
            printer
              .size(1, 1)
              .align('LT')
              .text(channel)
              .size(0,0)
              .text('')
              .text('Time '+stringDateTimeReceipt(timestamp))
              .drawLine()  
              .text((item.qty + (item?.diffQty || 0)).toString()+"x  " +item.name)
              if(item.option.length > 0){
                printer
                  .tableCustom(
                    [
                      { text:'   '+item.option.join(' / '), align:"LEFT"},
                    ],
                  )
              }
              if(item.addOn){
                printer
                  .tableCustom(
                    [
                      { text:'   '+item.addOn, align:"LEFT"},
                    ],
                  )
              }
            printer
              .drawLine()
              .text('')
              printer
              // .cut()   // full cut
              .cut(true)  // partial cut
              .close()    
  
          }
          
          
        })
  
      });
    }catch(err){
    //   rn_bridge.channel.send("Error: " + JSON.stringify(err) + " => " + err.stack );
    }
      
  }
  
  async function printCashierOrder(netWorkDeviceList,objOrder){
  // async function printCashierOrder(objShop,objOrder){
  // async function printCashierOrder(){
    try{
      const abc = 'escpos-network xxxx';
    //   await rn_bridge.channel.send(abc);
  
      var escpos = require('escpos');
      escpos.Network = require('escpos-network');
  
      const allDeviceList = [...netWorkDeviceList];
  
      allDeviceList.forEach(async (device)=>{
  
        const objDevice = new escpos.Network(device);
  
        objDevice.open(async (err)=>{
          if(err){  // handle error
            return
          }
  
          const options = { encoding: "Thai",lineWidth: 32 /* default */ }
          const printer = new escpos.Printer(objDevice, options);
  
          printer
            .align('CT')
            .size(1,1)
            .text(channel)
            .text('')
            .size(0, 0)
            .align('LT')
            // .text(stringDateTimeReceipt(objOrder.timestamp)+' '+objOrder.customer)
            // .text(' '+objOrder.customer)
            // .text('ลูกค้า : '+objOrder.customerQty.toString()+ ' ท่าน')
            .drawLine()
            .size(1,1 )
            .align('CT')
            .text('SUMMARY')
          printer
            .size(0,0)
            .drawLine()
          printer  
            .align('LT')
            .size(0, 0)
          for(const item of objOrder.product){
            printer
              .tableCustom(
                [
                  { text:(item.qty + (item?.diffQty || 0)).toString()+'x'+' ฿ '+item.totalPrice.toFixed(2), align:"LEFT",width:0.3},
                  { text:``+item.name, align:"RIGHT",width:0.7},
                ],
              )
              if(item.option.length > 0){
                printer
                  .tableCustom(
                    [
                      { text:'   '+item.option.join(' / '), align:"LEFT"},
                    ],
                  )
              }
              if(item.addOn){
                printer
                  .tableCustom(
                    [
                      { text:'   '+item.addOn, align:"LEFT"},
                    ],
                  )
              }
          }
          printer
            .text('')
            .cut(true)  // partial cut
            .close()
  
        })
  
  
      });
    }catch(err){
    //   rn_bridge.channel.send("Error: " + JSON.stringify(err) + " => " + err.stack );
    }
    
  }
  
  async function printInvoice(netWorkDeviceList,objBill){
  // async function printInvoice(objBill){
  // async function printInvoice(){
    try{
      const escpos = require('escpos');
      escpos.Network = require('escpos-network');
  
      const { 
         channel,  // temp data
         product, 
         vatType, totalQty, serviceChargeValue, vatValue, subTotal,
         net, beforeVat, vatAmount, serviceChargeAmount } = objBill;
  
      const allDeviceList = [...netWorkDeviceList];
  
      allDeviceList.forEach(async (device)=>{
        const objDevice = new escpos.Network(device);
        
        objDevice.open(async (err)=>{
          if(err){  // handle error
            return
          }
          
          const options = { encoding: "Thai",lineWidth: 32 /* default */ }
          const printer = new escpos.Printer(objDevice, options);
  
          printer
            .align('CT')
            .size(1, 1)
            .text(channel.join(' + '))
            .size(0,0)
            .drawLine()
            .size(1,1)
            .text('SUMMARY')
            .size(0,0)
            .drawLine()
          printer  
            .align('LT')
            .size(0, 0)
          for(const item of product){
            const { qty, diffQty, name, totalPrice, option, addOn } = item
            printer
              .tableCustom(
                [
                  { text:(qty + (diffQty || 0)).toString()+"x  " +name, align:"LEFT",width:0.7},
                  { text:totalPrice.toFixed(2), align:"RIGHT",width:0.3},
                ],
              ) 
              if(option.length > 0){
                printer
                  .tableCustom(
                    [
                      { text:'   '+option.join(' / '), align:"LEFT"},    // เพิ่มเส้น ซอสพริกไทย ไข่ดาว
                    ],
                  )
              }
              if(item.addOn){
                printer
                  .tableCustom(
                    [
                      { text:'   '+addOn, align:"LEFT"},
                    ],
                  )
              }
  
          }
          printer
            .text('')
            .align('LT')
            .text('item : '+totalQty.toString())
            .tableCustom(
              [
                { text:"Subtotal:", align:"RIGHT",width:0.66},
                { text:subTotal.toFixed(2), align:"RIGHT",width:0.33},
              ],
            )
            .tableCustom(
              [
                { text:`Service Charge(${serviceChargeValue.toString()}%):`, align:"RIGHT",width:0.66},
                { text:serviceChargeAmount.toFixed(2), align:"RIGHT",width:0.33},
              ],
            )
            if(vatType === "Include"){
              printer
                .tableCustom(
                  [
                    { text:"Total:", align:"RIGHT",width:0.66,style:'B'},
                    { text:net.toFixed(2), align:"RIGHT",width:0.33,style:'B'},
                  ],
                )
                .tableCustom(
                  [
                    { text:"Before VAT:", align:"RIGHT",width:0.66},
                    { text:beforeVat.toFixed(2), align:"RIGHT",width:0.33},
                  ],
                )
                .tableCustom(
                  [
                    { text:`VAT(${vatValue.toString()}%):`, align:"RIGHT",width:0.66},
                    { text:vatAmount.toFixed(2), align:"RIGHT",width:0.33},
                  ],
                )
                .tableCustom(
                  [
                    { text:"Amount Net:", align:"RIGHT",width:0.66,style:'B'},
                    { text:net.toFixed(2), align:"RIGHT",width:0.33,style:'B'},
                  ],
                )
            }
            if(vatType === "Exclude"){
              printer
                .tableCustom(
                  [
                    { text:"Before VAT:", align:"RIGHT",width:0.66},
                    { text:beforeVat.toFixed(2), align:"RIGHT",width:0.33},
                  ],
                )
                .tableCustom(
                  [
                    { text:`VAT(${vatValue.toString()}%):`, align:"RIGHT",width:0.66},
                    { text:vatAmount.toFixed(2), align:"RIGHT",width:0.33},
                  ],
                )
                .tableCustom(
                  [
                    { text:"Total:", align:"RIGHT",width:0.66,style:'B'},
                    { text:net.toFixed(2), align:"RIGHT",width:0.33,style:'B'},
                  ],
                )
            }
          printer
            .text('')
            .text('')
          printer
            .cut(true)  // partial cut
            .close()
  
        })
  
  
      });
    }catch(err){
    //   rn_bridge.channel.send("Error: " + JSON.stringify(err) + " => " + err.stack );
    }
    
  }


  const netWorkDeviceList = ['192.168.0.231','192.168.0.232','192.168.0.233'];

    const objShop = {
      receipt:{
        footer:"Thank you & See you again:)",
        footerImage:{
          imageId:"https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/foods%2F417a27e8-6e5c-4a2b-bcc2-110516f60a7920230804204216.JPEG?alt=media&token=4084a663-f66e-4867-a7c4-1c4999550e25",
          status:false,
        },
        // header:"บริษัท ตำกระด้ง จำกัด        444 Siam Aquare Soi 7, Rama 1 Road, Pathumwan,Bangkok, 10330 Thailand        TAX ID : 0105569384059         ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ",
        header:`บริษัท ตำกระด้ง จำกัด
        444 Siam Aquare Soi 7, Rama 1 Road,
        Pathumwan,Bangkok, 10330 Thailand
        TAX ID : 0105569384059
        ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ`,
        headerImage:{
          // imageId:"https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/foods%2F7e558681-eaee-4166-a441-bc22864d79c020230804204500.JPEG?alt=media&token=a3e1959d-0e8e-463a-abbf-72e0e1a85bc7",
          // imageId:'https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/headerReceipt%2F5ab2fe25-a3d8-488c-a275-0a8a36b3d31020230507194531.JPEG?alt=media&token=28b309cc-990b-4b4c-a638-2c2476180c1c',
          imageId:'https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/headerReceipt%2F5ab2fe25-a3d8-488c-a275-0a8a36b3d31020230507194531.JPEG?alt=media&token=28b309cc-990b-4b4c-a638-2c2476180c1c',
          status:true,
        },
      },
      channel:[
        {
          id:1,
          name:"ทานที่ร้าน",
        },
        {
          id:"09a7ecc9-0c71-404f-b60f-1bb7e6553fcc",
          name:"Take away",
        },
        {
          id:"645054d6-d971-444c-a826-e5473cba047a",
          name:"ขายบน Salepage",
        },
        {
          id:"f42d9126-1723-4562-b50d-5c99d3e660a0",
          name:"ขายผ่าน Grab ",
        },
        {
          id:"281c7fcd-cb33-48df-8eab-ec24c7d97708",
          name:"ขายผ่าน Shoppee food",
        },
      ],
      smartTable:[
        {
          config:{
            id:'65924b1f-b155-4ff0-ae97-d771ce8f8119',
            mainId:'1',
            name:'โต๊ะที่1',
            timestamp:new Date(),
            zoneId:'615c8fca-231d-46bc-9f7b-ae816409f3a7',
          },
          chair:6,
        },
        {
          config:{
            id:'f0db5d4e-12f4-427d-94df-83cdcbc994c2',
            mainId:'1',
            name:'ระเบียงซ้าย',
            timestamp:new Date(),
            zoneId:'2f868c4e-33c1-437e-88ae-29b08c1d34aa',
          },
          chair:4,
        },
        {
          config:{
            id:'8d26ab90-37b9-4de6-aa35-3dd5d88e3612',
            mainId:'1',
            name:'ระเบียงขวา',
            timestamp:new Date(),
            zoneId:'2f868c4e-33c1-437e-88ae-29b08c1d34aa',
          },
          chair:4,
        },
        {
          config:{
            id:'d9b28da0-aeeb-46ca-bded-e1c9bf523b2a',
            mainId:'1',
            name:'โต๊ะ  2',
            timestamp:new Date(),
            zoneId:'615c8fca-231d-46bc-9f7b-ae816409f3a7',
          },
          chair:4,
        },
        {
          config:{
            id:'02654b61-b9c6-472a-b211-b64a02cb2d6a',
            mainId:'1',
            name:'โต๊ะ 3',
            timestamp:new Date(),
            zoneId:'615c8fca-231d-46bc-9f7b-ae816409f3a7',
          },
          chair:4,
        },
        {
          config:{
            id:'a145d942-7641-4a74-b397-84387da14c8b',
            mainId:'1',
            name:'โต๊ะที่1',
            timestamp:new Date(),
            zoneId:'615c8fca-231d-46bc-9f7b-ae816409f3a7',
          },
          chair:4,
        },

      ],
    };

    // 0Oq8vanRIZRYdRYLKn9b
    const objBill = {
        shopName:'',
        shopId:'eRe3oswlvhoMGEPbdAR4',
        scShopId:'1',
        channel:['โต๊ะ 3' , 'โต็ะ 2'],
        receiptType:'normal',   // // 'normal' || 'void' || 'reprint'
        timestamp:new Date(),
        receiptNumber:'20230719-204742',
        staff:{
          email:'Barministryofsingle',
          name:'Bar 3th floor',
          tel:'0959369635',
        },
        totalQty:6,
        subTotal:740,
        serviceChargeAmount:74,
        serviceChargeValue:10,
        beforeVat:841,
        vatType:"Exclude",  // "Include" || "Exclude"
        vatAmount:56.98,
        vatValue:7,
        net:870.98,
        product:[
          {
            id:"fijvuNyGjyufmfhEqfsY",
            name:'Octopus Calamari / ทาโก๊ะคารามารี่',
            option:[],
            addOn:'ไม่เอาผัก',
            qty:1,
            diifQty:0,
            totalPrice:70
          },
          // {
          //   id:"abc",
          //   name:'adbcde / ทาโก๊ะคารามารี่',
            // option:'',
            // addOn:'',
          //   qty:1,
          //   diifQty:0,
          //   totalPrice:70
          // },
          {
            id:"o50Ysc2iBn9Zc3q8W6H6",
            name:'Grilled beef with thai spicy / เนื้อย่างจิ้มแจ่ว',
            option:['size L','เครื่องเคียง','ไข่ดาว'],
            addOn:'ไม่เผ็ดมาก',
            qty:1,
            diifQty:0,
            totalPrice:130
          },
          {
            id:"cGlGNioO7iU9U5Il7IP3",
            name:'Singha',
            option:[],
            addOn:'',
            qty:1,
            diifQty:0,
            totalPrice:180
          },
          {
            id:"B7qFq8DoZoXqOeAbNMaB",
            name:'Heineken',
            option:[],
            addOn:'',
            qty:1,
            diifQty:0,
            totalPrice:200
          },
          {
            id:"8UouZs8OzCGREoMV9xJj",
            name:'Icelandic Mineral Water',
            option:[],
            addOn:'',
            qty:2,
            diifQty:0,
            totalPrice:160
          },
        ],
        payment:[
          {
            amount:"740.00",
            fee:"1.6",
            id:"003",
            name:"Visa Standard",
            type:"creditCard",
          }
        ],
        
    };

    const objOrder = {
      channelId:'f0db5d4e-12f4-427d-94df-83cdcbc994c2',
      channel:['โต๊ 2'],
      // customerQty:'2',
      product:[
        {
          name:'Octopus Calamari / ทาโก๊ะคารามารี่',
          detail:'',
          option:[],
          addOn:'ไม่เอาผัก', 
          totalPrice:70,
          qty:1,
          diffQty:0,
        },
        {
          name:'Grilled beef with thai spicy / เนื้อย่างจิ้มแจ่ว',
          detail:'',
          option:['size L','เครื่องเคียง','ไข่ดาว'],
          addOn:'ไม่เผ็ดมาก',
          totalPrice:130,
          qty:1,
          diffQty:0,
        },
      ],
      // table:{  // deplecated !
      //   id:'21042023165700',
      //   name:'Bar Table (B) ',
      //   number:'08',
      //   people:2,
      //   size:'2'
      // },
      
      customer:'แพ็คแมน',
      timestamp:new Date(),
    }
  
  const stringDateTimeReceipt = (_date) => {
    const date = new Date(_date);
    const cDateTime =
        date.getDate().toString().padStart(2,"0") + "/"+
        parseInt(date.getMonth()+1).toString().padStart(2,"0") +"/"+
        date.getFullYear().toString().padStart(4,"0")+" " +
        date.getHours().toString().padStart(2,"0")+":"+
        date.getMinutes().toString().padStart(2,"0")
  
    return cDateTime;  // 27/06/2021 00:25:26
  }
  
  function findInArray(arr,propertise,value){
    return arr.find(item=>item[propertise] === value)
  };
  
  function filterDeleteInArray(arr,propertise,value){
    return arr.filter(item=>item[propertise] !== value)
  };
  
  function getChannelName(objShop,objOrder){
    const { smartTable,channel } = objShop;
    const { channelId } = objOrder;
  
    let newSmartTable = [];
    smartTable.forEach(item => newSmartTable.push({...item.config}))
    const allSaleChannel = [...filterDeleteInArray(objShop.channel,'id',1),...newSmartTable] ;
    const objChannel = findInArray(allSaleChannel,'id',channelId);
  
    return objChannelName.name;
  }

  printReceipt(netWorkDeviceList,objShop,objBill);
  // printTotalOrder(netWorkDeviceList,objOrder);
  // printItemOrder(netWorkDeviceList,objOrder);
  // printCashierOrder(netWorkDeviceList,objOrder);
  // printInvoice(netWorkDeviceList,objBill);