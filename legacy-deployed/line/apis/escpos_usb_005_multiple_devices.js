// 'use strict';
// const escpos = require('..');
const escpos = require('escpos');
escpos.USB = require('escpos-usb');


const device  = new escpos.USB();

const usbDeviceList = escpos.USB.findPrinter();
// const deviceChosen = devices.find(printerUSB => { return JSON.stringify(printerUSB.portNumbers) === printParam.address; });

console.log("USB.findPrinter()");
console.log( usbDeviceList );

const allDeviceList = [...usbDeviceList];


allDeviceList.forEach(async (usbDevice)=>{
  let device = new escpos.USB(usbDevice);

  device.open(async (err)=>{
    if(err){
      // handle error
      return
    }

    // encoding is optional
    const options = { encoding: "GB18030" /* default */ }
    let printer = new escpos.Printer(device, options);

      printer
      .font('a')
      .align('ct')
      .style('bu')
      .size(1, 1)
      .text('The quick brown fox jumps over the lazy dog')
      .text('敏捷的棕色狐狸跳过懒狗')
      .barcode('1234567', 'EAN8')
      .qrimage('https://github.com/node-escpos/driver', function(err){
        this.cut();
        this.close();
      });

  });
})


// // const devices = USB.findPrinter();
// // const network = new escpos.Network('localhost');
// // const lp0     = new escpos.Serial('/dev/usb/lp0');
// // const usb     = escpos.USB(0x01, 0xff);

// // const printer = new escpos.Printer([
// //   devices[1],
// //   devices[3],
// //   network,
// //   lp0,
// //   usb
// // ]);

// const printer = new escpos.Printer([
//   devices[0],
//   devices[1]
// ]);

// device.open(function(){

//   printer
//   .font('a')
//   .align('ct')
//   .style('bu')
//   .size(1, 1)
//   .text('The quick brown fox jumps over the lazy dog')
//   .text('敏捷的棕色狐狸跳过懒狗')
//   .barcode('1234567', 'EAN8')
//   .qrimage('https://github.com/node-escpos/driver', function(err){
//     this.cut();
//     this.close();
//   });

// });