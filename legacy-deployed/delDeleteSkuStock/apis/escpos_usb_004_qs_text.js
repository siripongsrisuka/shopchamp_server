// 'use strict';
// const escpos = require('../');

// const escpos = require('escpos');

const escpos = require('escpos')
escpos.USB = require('escpos-usb')
const { usb, getDeviceList } = require('usb');
const printerData = getDeviceList();
console.log(printerData);

// const printerData = usb.findPrinter();
// console.log(printerData);

// const printerData = escpos.USB.findPrinter();
// console.log(printerData);

// const device  = new escpos.USB(0x0485, 0x7541);
const device  = new escpos.USB(printerData[0].deviceDescriptor.idVendor, printerData[0].deviceDescriptor.idProduct);
// const device  = new escpos.Network('localhost');
// const device  = new escpos.Serial('/dev/usb/lp0');
const printer = new escpos.Printer(device);

// device.open(function(err){

//   printer
//   .model('qsprinter')
//   .font('a')
//   .align('ct')
//   .style('bu')
//   .size(1, 1)
//   .encode('tis620')
//   .text('The quick brown fox jumps over the lazy dog')
//   .text('สวัสดีภาษาไทย')
//   .close();
//   // .text('敏捷的棕色狐狸跳过懒狗')
//   // .barcode('1234567', 'EAN8')
//   // .qrimage('https://github.com/node-escpos/driver', function(err){
//   //   this.cut();
//   //   this.close();
//   // });

// });