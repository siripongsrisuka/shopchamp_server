// import { Image, Printer } from "@node-escpos/core";
const {  Printer, Image } = require("@node-escpos/core")
// import USB from "@node-escpos/usb-adapter";
const USB = require("@node-escpos/usb-adapter");
// import { join } from "path";
const { join } = require("path");

// import { describe, it } from "vitest";


const device  = new USB();


device.open(async function(err){
  if(err){
    reject(err);
    return
  }

  let printer = new Printer(device, {});

  // const tux = join(__dirname, './assets/tux.png');
  // const tux = join(__dirname, './assets/pikachu.png');
  const tux = join(__dirname, './assets/reciept.jpeg');
  
  const image = await Image.load(tux);

  printer
    .font("a")
    .align("ct")
    .style("bu")
    .size(1, 1)
    .text("The quick brown fox jumps over the lazy dog")
    .text("敏捷的棕色狐狸跳过懒狗")
    .text("ไก่ไข่ควาย")
    .barcode(112233445566, "EAN13", { width: 50, height: 50 })
    .table(["One", "Two", "Three"])
    .tableCustom(
      [
        { text: "Left", align: "LEFT", width: 0.33, style: "B" },
        { text: "Center", align: "CENTER", width: 0.33 },
        { text: "Right", align: "RIGHT", width: 0.33 },
      ],
      // { encoding: "cp857", size: [1, 1] }, // Optional
    )
    
  // inject qrimage to printer
  printer = await printer.qrimage("https://github.com/node-escpos/driver")
  // inject image to printer
  printer = await printer.image(image, "s8")  // "s8" | "d8" | "s24" | "d24"

  printer
    .cut()
    .close()
    .finally()

  // printer
  //   .finally(resolve)
});
