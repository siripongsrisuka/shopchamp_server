const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch-commonjs");   // config adjust of "node-fetch" ,for compatible with all javascript,ESM,node version
const axios = require("axios");
const env = require("../env.json");

const app = express();
app.use(cors({origin:true}));

const { checkSharedDataGrantUser, validateAndRefeshAuthToken, checkIfAuthenticated } = require("../middlewares/auth_middleware");
const { findInArray, summary, formatTime } = require("../helpers/functions");
const { minusDays, NumberYMD } = require("../helpers/dateTime");


var db = admin.firestore(); // Initialize Firestore database
// checkPhoneRegister

app.post("/memberList", async (req, res) => {
    try {
        let arr = []
        for(let i =1; i<50; i++){
            arr.push({ id:i+'xxxxxxxxxxxxxxxxxxxxxx', tel:'0956909711', name:'gift คนสวย'})
        }

        res.status(200).send(arr);

    } catch (err) {
        console.error("Pagination Error:", err);
        res.status(500).send({ message: "Internal Server Error", error: err });
    }
});


module.exports = app;
