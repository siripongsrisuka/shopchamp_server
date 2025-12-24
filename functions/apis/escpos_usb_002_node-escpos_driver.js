// import { Printer, Image } from "@node-escpos/core";
const {  Printer, Image,Bluetooh } = require("@node-escpos/core")

// install escpos-usb adapter module manually
// import USB from "@node-escpos/usb-adapter";
const USB = require("@node-escpos/usb-adapter");
const NET = require("@node-escpos/network-adapter");
// Select the adapter based on your printer type
// import { join } from "path";

const { join } = require("path");

// const device = new USB();
// const device = new NET('192.168.0.232');
const device = new NET('192.168.1.100');
// console.log("device");
console.log(JSON.stringify(device,null,4));

// const usbDeviceList = USB.findPrinter();
// console.log("USB.findPrinter()");
// console.log( usbDeviceList );

// console.log("USB.getDevice()");
// async function getDevice(){
//   const getDevice = await USB.getDevice();
//   console.log(USB.getDevice());   
// } 
// console.log(getDevice());

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

  printer
    .font("a")
    .align("ct")
    .style("bu")
    .size(1, 1)
    .text("May the gold fill your pocket")
    .text("ไก่ไข่ควายงู")
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

  printer
    .cut()
    .close()

    // printer
    // .close()

});



