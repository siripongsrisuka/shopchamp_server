console.log('test test')

const escpos = require('escpos');
// install escpos-usb adapter module manually
escpos.USB = require('escpos-usb');
escpos.Network = require('escpos-network');

const axios = require('axios');
const path = require('path');

const fs = require('fs');
const PNG = require('pngjs').PNG;

const https = require('https');


// Select the adapter based on your printer type
// const objDevice  = new escpos.USB();
// const device  = new escpos.Network('localhost');
// const objDevice  = new escpos.Network('192.168.1.231');
// const objDevice  = new escpos.Network('192.168.2.231');
const objDevice  = new escpos.Network('192.168.180.239');
// const objDevice  = new escpos.Network('192.168.180.23dsafdafsdf');
// const objDevice  = new escpos.Network('192.168.1.234');
// const objDevice  = new escpos.Network('192.168.1.232');
// const objDevice  = new escpos.Network('192.168.1.233');
// const objDevice  = new escpos.Network('192.168.187.239');
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
  // const imageUrl = 'https://e7.pngegg.com/pngimages/501/208/png-clipart-the-pokemon-company-pokemon-go-pikachu-logo-wonder-pets-turtle-text-logo.png';  // png
  const imageUrl = 'https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/headerReceipt%2F5ab2fe25-a3d8-488c-a275-0a8a36b3d31020230507194531.JPEG?alt=media&token=28b309cc-990b-4b4c-a638-2c2476180c1c';    // may jpeg
  // const imageBase64 = await convertImageToBase64(imageUrl);
  // const imagePath = "data:image/png;base64," + imageBase64;
  // const imagePath = "data:image/png;base64," + 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAH0lEQVR42mNk+M9Qz0BFwDhq4KiBowaOGjhq4Eg1EAAlJx3tIbLVagAAAABJRU5ErkJggg==';
  const imagePath = "data:image/png;base64," + 'iVBORw0KGgoAAAANSUhEUgAAAPoAAAD6CAYAAACI7Fo9AAACLklEQVR42u3TAQ0AAAjDsKMc6WAABaSVsGSVSQd4rYwORgeMDhgdMDpgdMDogNEBo4PRAaMDRgeMDhgdMDpgdMDoYHTA6IDRAaMDRgeMDhgdMDoY3ehgdMDogNEBowNGB4wOGB0wOhgdMDpgdMDogNEBowNGB4wORgeMDhgdMDpgdMDogNEBo4PRjQ5GB4wOGB0wOmB0wOiA0QGjg9EBowNGB4wOGB0wOmB0wOhgdMDogNEBowNGB4wOGB0wOhjd6GB0wOiA0QGjA0YHjA4YHTA6GB0wOmB0wOiA0QGjA0YHjA5GB4wOGB0wOmB0wOiA0QGjg9FlAKMDRgeMDhgdMDpgdMDogNHB6IDRAaMDRgeMDhgdMDpgdDA6YHTA6IDRAaMDRgeMDhgdjA4YHTA6YHTA6IDRAaMDRgeMDkYHjA4YHTA6YHTA6IDRAaOD0QGjA0YHjA4YHTA6YHTA6GB0wOiA0QGjA0YHjA4YHTA6YHQwOmB0wOiA0QGjA0YHjA4YHYwOGB0wOmB0wOiA0QGjA0YHowNGB4wOGB0wOmB0wOiA0QGjg9EBowNGB4wOGB0wOmB0wOhgdMDogNEBowNGB4wOGB0wOhgdMDpgdMDogNEBowNGB4wOGB2MDhgdMDpgdMDogNEBowNGB6MDRgeMDhgdMDpgdMDogNHB6IDRAaMDRgeMDhgdMDpgdMDoYHTA6IDRAaMDRgeMDhgdMDoYHTA6YHTA6IDRAaMDRgcuC3WfdhYeFN1xAAAAAElFTkSuQmCC';
    // const imagePath = "data:image/png;base64," + "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";


  // // Image #2, direct path (support only .png and has mistake on some .png file)
  // const imagePath = path.join(__dirname, 'assets/download.png');
  // const imagePath = path.join(__dirname, 'assets/tux.png');
  // const imagePath = path.join(__dirname, 'assets/pikachu.png');
  // const imagePath = path.join(__dirname, 'assets/tamKaDong.png');
  // const imagePath = path.join(__dirname, 'assets/demoPng(oldMayFromJpg).png');
  // const imagePath = await processPngImage(path.join(__dirname, 'assets/demoPng(oldMayFromJpg).png'));
  // const imagePath = await processPngImage(path.join(__dirname, 'assets/tux.png'));

  // return 

  // // Image #3, direct website url (support both .jpg , .png)
  // const imagePath ='https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSXJFJ_jT9kTrXC8lzxhhhQLaY1xbiVHZ9gUrnKxV-rmoob83VY';
  // const imagePath = 'https://raw.githubusercontent.com/node-escpos/driver/main/examples/demo/assets/tux.png';
  // const imagePath = 'https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/law%2F404cdea8-24ff-41d2-bdae-ab63b4219b1c20230623230729.JPEG?alt=media&token=51bfe95c-7f12-484a-aa55-06e8469f3d83';
  // const imagePath = 'https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/mainImage%2Flogo.png?alt=media&token=8cbe85a7-4c5d-4389-9e35-5a8d643bec6c'
  // const imagePath = 'https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/headerReceipt%2F5ab2fe25-a3d8-488c-a275-0a8a36b3d31020230507194531.JPEG?alt=media&token=28b309cc-990b-4b4c-a638-2c2476180c1c'
  // const imagePath = 'https://firebasestorage.googleapis.com/v0/b/shopchamp-restaurant.appspot.com/o/test%2FdemoPng(oldMayFromJpg).png?alt=media&token=12977f12-b3a8-4b63-928f-1c466a6ac602'   // image from react-native-image-resizer


  escpos.Image.load(imagePath, function(image){
    objDevice.open(function(error){
        // printer.flush().raw('1b 70 64 19 03').flush() // beep sound
        // printer.flush().raw('1b 42 03').flush() // beep sound
        // printer.flush().raw('1b 4d 01').flush() // Strikethrough text

        if(error){
          console.log(error)
          return
        }


        // // print test
        printer
          .align('ct')
          // .image(image, 's8')
          .image(image, 'd24')
          // .raster(image)
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

        // // // test get printer status
        // if (error) {
        //   console.error('Error opening device:', err);
        //   return;
        // }
      
        // // Send DLE EOT 1 command to request printer status
        // const DLE = 0x10;
        // const EOT = 0x04;
        // const statusCommand = Buffer.from([DLE, EOT, 0x01]);
      
        // objDevice.write(statusCommand, (error) => {
        //   if (error) {
        //     console.error('Error writing to printer:', error);
        //     return;
        //   }
      
        //   // Listen for response from the printer
        //   objDevice.on('data', (data) => {
        //     console.log('Printer status:', data);
        //     // Process the status data as needed
        //   });
        // });

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


async function processPngImage(imagePath) {
  console.log('imagePath')
  console.log(imagePath)

  return new Promise((resolve, reject) => {
    fs.createReadStream(imagePath)
      .pipe(new PNG({
        filterType: 4
      }))
      .on('parsed', function() {
        try {
          const buffer = PNG.sync.write(this);
          resolve(buffer);
        } catch (error) {
          reject(error);
        }
      })
      .on('error', reject);
  });
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