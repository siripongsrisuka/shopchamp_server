const {  Printer, Image } = require("@node-escpos/core")
const USB = require("@node-escpos/usb-adapter");
// const BLE = require("@node-escpos/bluetooth-adapter");  
const { join } = require("path");

const usbDeviceList = USB.findPrinter();
console.log("USB.findPrinter()");
console.log( usbDeviceList );

// console.log("USB.getDevice()");
// async function getDevice(){
//   const getDevice = await USB.getDevice();
//   console.log(USB.getDevice());  
// } 
// console.log(getDevice());

// const bleDeviceList = BLE.list();
// console.log("BLE.list()");
// console.log(bleDeviceList);



const allDeviceList = [...usbDeviceList];

// return

allDeviceList.forEach(async (usbDevice)=>{
  let device = new USB(usbDevice);

  device.open(async function(err){
    if(err){
      // handle error
      return
    }

    // encoding is optional
    const options = { encoding: "GB18030" /* default */ }
    let printer = new Printer(device, options);
    // let printer = new Printer(usbDeviceList[0], options);

    // Path to png image
    // const filePath = join("/PATH/TO/IMAGE");
    // const image = await Image.load(filePath);

    await printer
      .font("a")
      .align("ct")
      .style("bu")
      .size(1, 1)
      .text("May the gold fill your pocket")
      .text("恭喜发财")
      .barcode(112233445566, "EAN13", { width: 50, height: 50 })
      .table(["One", "Two", "Three"])
      .tableCustom(
        [
          { text: "Left", align: "LEFT", width: 0.33, style: "B" },
          { text: "Center", align: "CENTER", width: 0.33 },
          { text: "Right", align: "RIGHT", width: 0.33 },
        ],
        { encoding: "cp857", size: [1, 1] }, // Optional
      )

      
    // inject qrimage to printer
    // printer = await printer.qrimage("https://github.com/node-escpos/driver")

    
    // inject image to printer
    // printer = await printer.image(
    //   image, 
    //   "s8" // changing with image
    // )

    
    await printer
      .cut()
      .close()

      // printer
      // .close()

  });
})





