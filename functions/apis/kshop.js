const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch-commonjs");   // config adjust of "node-fetch" ,for compatible with all javascript,ESM,node version
const axios = require("axios");
const env = require("../env.json");
const QRCode = require('qrcode');

const app = express();
app.use(cors({origin:true}));


// checkPhoneRegister

app.post("/test", async (req, res) => {
    try {
        const qrString = '00020101021230690016A000000677010112011301055580807780211LEX110000020313LEX026039306931590016A00000067701011301030040211LEX110000020413LEX02603930695 303764540512.815802TH6304A2C1'
        QRCode.toDataURL(qrString, function (err, url) {
        console.log(url); // ส่งไปแสดงใน <img src={url} />
        });
        res.status(200).send('hello');

    } catch (err) {
        console.error("Pagination Error:", err);
        res.status(500).send({ message: "Internal Server Error", error: err });
    }
});


module.exports = app;
