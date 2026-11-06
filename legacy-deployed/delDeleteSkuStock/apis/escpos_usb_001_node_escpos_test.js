console.log('test test')

const escpos = require('escpos');
// install escpos-usb adapter module manually
escpos.USB = require('escpos-usb');
escpos.Network = require('escpos-network');

const axios = require('axios');
const path = require('path');


// Select the adapter based on your printer type
// const objDevice  = new escpos.USB();
// const device  = new escpos.Network('localhost');
// const objDevice  = new escpos.Network('192.168.1.232');
const objDevice  = new escpos.Network('192.168.1.233');
// const objDevice  = new escpos.Network('192.168.1.231');
// const objDevice  = new escpos.Network('192.168.0.96');
// const objDevice  = new escpos.Network('192.168.112.233');

// const objDevice  = new escpos.Network('192.168.1.100');
// const device  = new escpos.Serial('/dev/usb/lp0');



// const options = { encoding: "GB18030" /* default */ }
// const options = { encoding: "860" /* default */ }
const options = { encoding: "windows-874" /* default */ }
// const options = { encoding: "PC874" /* default */ }
// const options = { encoding: "21" /* default */ }
// const options = { encoding: "utf-8" /* default */ }
// const options = { encoding: "Tis-620" /* default */ }
// const options = { encoding: "Thai" /* default */ }
// const options = { encoding: "Thai",lineWidth: 32 /* default
// lineWidth: 32
// const options = { encoding: "Thai",width:58 /* default */ }
// const options = { encoding: "PC874" /* default */ }
// const options = { encoding: "874" /* default */ }
// const options = { encoding: "255" /* default */ }
// const options = { encoding: "96" /* default */ }
// const options = { encoding: "tis620" /* default */ }
// encoding is optional

const printer = new escpos.Printer(objDevice, options);

async function printReceipt(){

  // // Image #1, base64 image data from url (support only .png and has mistake on some .png file)
  // const imageUrl = 'https://e7.pngegg.com/pngimages/501/208/png-clipart-the-pokemon-company-pokemon-go-pikachu-logo-wonder-pets-turtle-text-logo.png';
  // const imageUrl = 'https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/headerReceipt%2F5ab2fe25-a3d8-488c-a275-0a8a36b3d31020230507194531.JPEG?alt=media&token=28b309cc-990b-4b4c-a638-2c2476180c1c';
  // const imageBase64 = await convertImageToBase64(imageUrl);
  // const imagePath = "data:image/png;base64," + imageBase64;

  // // Image #2, direct path (support only .png and has mistake on some .png file)
  // const imagePath = path.join(__dirname, 'assets/download.png');
  // const imagePath = path.join(__dirname, 'assets/tux.png');
  // const imagePath = path.join(__dirname, 'assets/pikachu.png');
  // const imagePath = path.join(__dirname, 'assets/tamKaDong.png');

  // // Image #3, direct website url (support both .jpg , .png)
  // const imagePath ='https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSXJFJ_jT9kTrXC8lzxhhhQLaY1xbiVHZ9gUrnKxV-rmoob83VY';
  // const imagePath = 'https://raw.githubusercontent.com/node-escpos/driver/main/examples/demo/assets/tux.png';
  // const imagePath = 'https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/law%2F404cdea8-24ff-41d2-bdae-ab63b4219b1c20230623230729.JPEG?alt=media&token=51bfe95c-7f12-484a-aa55-06e8469f3d83';
  // const imagePath = 'https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/mainImage%2Flogo.png?alt=media&token=8cbe85a7-4c5d-4389-9e35-5a8d643bec6c'
  const imagePath = 'https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/headerReceipt%2F5ab2fe25-a3d8-488c-a275-0a8a36b3d31020230507194531.JPEG?alt=media&token=28b309cc-990b-4b4c-a638-2c2476180c1c'

  escpos.Image.load(imagePath, function(image){
    objDevice.open(function(error){
        // printer.flush().raw('1b 70 64 19 03').flush() // beep sound
        // printer.flush().raw('1b 42 03').flush() // beep sound
        // printer.flush().raw('1b 4d 01').flush() // Strikethrough text

        printer
          .align('ct')
          // .image(image, 's8')
          .image(image, 'd24')
        printer  
          .align('LT')
          .size(0, 0)
          .tableCustom(
            [
              { text:"1x เมื่ยงปลาทอด นครปฐม องค์พระ", align:"LEFT",width:0.7,style:'BU'},
              { text:"230.00", align:"RIGHT",width:0.3},
            ],
          )
          .drawLine()
          .tableCustom(
            [
              { text:"", align:"LEFT", width:0.3, style: 'B' },
              { text:"Subtotal", align:"CENTER",width:0.3},
              { text:"230.00", align:"RIGHT",width:0.3},
            ],
          )
          .tableCustom(
            [
              { text:"", align:"LEFT", width:0.3, style: 'B' },
              { text:"Subtotal", align:"CENTER",width:0.3},
              { text:"230.00", align:"RIGHT",width:0.3},
            ],
          )
          .align('ct')
          // .qrimage('https://github.com/song940/node-escpos', function(err){
          .qrimage('https://github.com/song940/node-escpos',{ type: 'png', margin:0, size:20}, function(err){
          // .qrimage('xxx',{ type: 'png', margin:0, size:10}, function(err){
          // .qrimage('https://www.google.com/', function(err){
          // .qrimage('xxx', function(err){
            this.text('')
            this.cut();
            this.close();
            // this.beep();
          })
          // .text('')
          // .cut()
          // .close()

    });    
  });



}

printReceipt();




async function convertImageToBase64(url) {
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const imageData = Buffer.from(response.data, 'binary').toString('base64');
    return imageData;
  } catch (error) {
    console.error('Error fetching or converting image:', error);
    return null;
  }
}













  // // for(i=1;i <= 3;i++){
  //   printer
  //   // .font('a')
  //   // .align('ct')
  //   .align('LT')
  //   // .style('bu')
  //   // .size(1, 1)
  //   .size(0, 0)
  //    printer
  //     // .align('lt')
  //     // .print('1' + "X ")
  //     // .print('Hawaian Pizze Medium Size')
	// 	  // .println('เมี่ยงปลาทอด')
  //   // .text('The quick brown fox jumps over the lazy dog')
  //   // .text('敏捷的棕色狐狸跳过懒狗 adfas ไก่ไข่ควายงู +๑๒๓๔ู฿๕๖',"windows-874")
  //   // .text('ไก่ไข่ควายงู','windows-874')
  //   // .align('rt')
  //   // .text('ไก่ไข่ควายงู อุอู ดีดี่ดี้ดี๊ดี๋ สุ่โค้ยย')
  //   // for(i=1;i <= 3;i++){
  //   //   printer.text('ไก่ไข่ควายงู อุอู ดีดี่ดี้ดี๊ดี๋ สุ่โค้ยย:'+i)
  //   // }
  //   // printer.barcode('1234567', 'EAN8')
  //   // .table(["One", "Two", "Three"])
  //   .tableCustom(
  //     [
  //       { text:"1x เมื่ยงปลาทอด นครปฐม องค์พระ", align:"LEFT",width:0.7},
  //       { text:"230.00", align:"RIGHT",width:0.3},
  //       // { text:"Right", align:"RIGHT", width:0.33 },
  //     ],
  //   )
  //   .drawLine()
  //   .tableCustom(
  //     [
  //       { text:"777", align:"LEFT", width:0.3, style: 'B' },
  //       { text:"Subtotal", align:"CENTER",width:0.3},
  //       { text:"230.00", align:"RIGHT",width:0.3},
  //       // { text:"Right", align:"RIGHT", width:0.33 },
  //     ],
  //     // { encoding: 'cp857', size: [1, 1] } // Optional
  //   )
  //   // .tableCustom(
  //   //   [
  //   //     { text:"Left", align:"LEFT", width:0.2, style: 'B', },
  //   //     { text:"Center", align:"CENTER", width:0.2},
  //   //     { text:"Right", align:"RIGHT", width:0.2 }
  //   //   ],
  //   //   // { encoding: 'cp857', size: [1, 1] } // Optional
  //   //   { encoding: 'cp857', size: [0.3, 0.3] } // Optional
  //   // )
  //   // .qrimage('https://github.com/song940/node-escpos', function(err){
  //   //     this.cut();
  //   //     this.close();
  //   // });
  //   .qrimage('https://github.com/song940/node-escpos',function(err){})


  //   // printer.align("CT");
  //   // printer.feed();
  //   // printer.size(0, 0);
  //   // printer.text("สุ่โค้ยย SIZE 0");
  //   // printer.size(1, 1);
  //   // printer.text("สุ่โค้ยย SIZE 1");
  //   // printer.size(2, 2);
  //   // printer.text("สุ่โค้ยย SIZE 2");
  //   // printer.size(3, 3);
  //   // printer.text("สุ่โค้ยย SIZE 3");
  //   // printer.size(0, 0);
  //   // printer.drawLine();
  //   // printer.size(2, 1);
  //   // printer.text("สุ่โค้ยย SIZE 2,1");
  //   // printer.size(0, 1);
  //   // printer.text("สุ่โค้ยย SIZE 0,1");
  //   // printer.size(3, 4);
  //   // printer.text("สุ่โค้ยย SIZE 3, 4");
  //   // printer.size(5, 6);
  //   // printer.text("สุ่โค้ยย SIZE 5,6");

  //   printer.text('')
  //   .cut()
  //   .close()

  //   // }