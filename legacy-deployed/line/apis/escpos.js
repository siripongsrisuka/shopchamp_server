const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
// const escpos = require('escpos');
// escpos.Bluetooth = require('escpos-bluetooth');
// escpos.USB = require('escpos-usb');

// const bluetoothDevice = new escpos.Bluetooth('01:23:45:67:89:AB', 1);
// const bluetoothScreen = new escpos.Screen(bluetoothDevice);

const app = express();
app.use(cors({origin:true}));

// printByBluetooth
app.get("/getFullPlayerData/:player_id", async (req,res) => {
    try{
        const {player_id} = req.params;
        const {xx } = req.body;


        functions.logger.info("function:getFullPlayerData:info",{message:"Success getFullPlayerData"});
        res.status(200).send(objFullPlayerData);

    }catch(err){
        functions.logger.error("function:getFullPlayerData:error",err);
        res.status(500).send({message:"Internal Server Error",error:err});
    }
});

module.exports = app;
