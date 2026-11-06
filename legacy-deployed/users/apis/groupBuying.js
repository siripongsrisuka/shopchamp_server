const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch-commonjs");   // config adjust of "node-fetch" ,for compatible with all javascript,ESM,node version

const app = express();
app.use(cors({origin:true}));




// //  postObjArr
app.post("/postObjArr", async (req,res) => {
    try{
        // const {
        //     dateTime,string,integer,minusInteger,
        //     decimal,boolean,array,object,arrObj
        // } = req.body;

        console.log("string:",req.body?.string);
        console.log("typeof string:",typeof req.body?.string);
        console.log("dateTime:",req.body?.dateTime);
        console.log("typeof dateTime:",typeof req.body?.dateTime);
        console.log("integer:",req.body?.integer);
        console.log("typeof integer:",typeof req.body?.integer);
        console.log("minusInteger:",req.body?.minusInteger);
        console.log("typeof minusInteger:",typeof req.body?.minusInteger);
        console.log("decimal:",req.body?.decimal);
        console.log("typeof decimal:",typeof req.body?.decimal);
        console.log("boolean:",req.body?.boolean);
        console.log("typeof boolean:",typeof req.body?.boolean);
        console.log("array:",req.body?.array);
        console.log("typeof array:",typeof req.body?.array);
        console.log("object:",req.body?.object);
        console.log("typeof object:",typeof req.body?.object);
        console.log("arrObj:",req.body?.arrObj);
        console.log("typeof arrObj:",typeof req.body?.arrObj);

        const sumVal = req.body?.arrObj.reduce((a, b) => a + ((b.val) || 0), 0)
        const dateTime2 = new Date(req.body?.dateTime);

        functions.logger.info("function:postObjArr:info",{message:`postObjArr`});
        res.status(200).send({...req.body,dateTime2:dateTime2,sumVal:sumVal});

    }catch(err){
        functions.logger.error("function:setAppReg:error",err);
        res.status(500).send({ message: "Internal Server Error",error:err});
    }
});



module.exports = app;
