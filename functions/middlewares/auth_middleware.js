// import admin from './firebase-service';

const functions = require("firebase-functions");
const admin = require("firebase-admin");

const axios = require("axios");
const env = require("../env.json");

const getAuthToken = (req,res,next) => {

    if(
        req.headers.authorization && 
        req.headers.authorization.split(' ')[0] == 'Bearer')
    {
        req.authToken = req.headers.authorization.split(' ')[1];
    }else{
        req.authToken = null
    }
    next();
};

const getRefreshToken = (req,res,next) => {

    if(
        req.headers.authorization && 
        req.headers.authorization.split(' ')[0] == 'Bearer')
    {
        req.refreshToken = req.headers.authorization.split(' ')[1];
    }else{
        req.refreshToken = null
    }
    next();
};

exports.checkIfAuthenticated = (req,res,next) => {
    getAuthToken(req,res,async () => {
        try{
            const { authToken } = req;
            const userInfo = await admin.auth().verifyIdToken(authToken);
            req.authId = userInfo.uid;
            return next();
        }catch(err){
            functions.logger.info("function:checkIfAuthenticated:catch",err);
            return res.status(401).send({error:'You are not authorized to make this request'});
        }
    });
};

exports.checkIfAdmin = (req,res,next) => {
    getAuthToken(req,res, async () => {
        try{
            const { authToken } = req;
            const userInfo = await admin.auth().verifyIdToken(authToken);

            if(userInfo.isAdmin === true) {
                req.authId = userInfo.uid;
                return next();
            }
            
            throw new Error('unauthorized');
        }catch(err){
            functions.logger.info("function:checkIfAdmin:catch",err);
            return res.status(401).send({error:'You are not authorized to make this request'});
        }
    });
};

exports.checkSharedDataGrantUser = (req,res,next) => {
    getAuthToken(req,res, async () => {
        try{
            const { authToken } = req;
            const userInfo = await admin.auth().verifyIdToken(authToken,true);

            if( userInfo?.isAdmin === true || userInfo?.isPartner === true ) {
                req.authId = userInfo.uid;
                if ( userInfo?.isAdmin === true ){
                    req.isAdmin = true;
                }else{
                    req.isAdmin = false;
                }
                return next();
            }
            
            throw new Error('unauthorized');
        }catch(err){
            functions.logger.info("function:checkIfPartner:catch",err);
            return res.status(401).send({error:'You are not authorized to make this request'});
        }
    });
};


exports.validateAndRefeshAuthToken = (req,res,next) => {
    getRefreshToken(req,res,async () =>{
        try{
            const { refreshToken } = req;

            const apiReq = {
                method: 'POST',
                url: `https://securetoken.googleapis.com/v1/token?key=${env.Web_API_Key}`,
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                },
                data: { // ("body")
                    grant_type:"refresh_token",
                    refresh_token:refreshToken,
                }
            };
            // !Note from experimental in firebase, after get new serie token old access and refresh token still can use, in thrid party libary cannot


            const response = await axios.request(apiReq);
            res.status(response.status).json(response.data);

            if (response.status === 200){
                req.status = response.status;
                req.data = response.data;
                // res.status(response.status).json(response.data);

                return next();
            }

            throw new Error('invalid');

        }catch(err){
            functions.logger.info("function:checkIfPartner:catch",err);
            return res.status(401).send({error:'The refesh token is invalid'});
        }
    });
}