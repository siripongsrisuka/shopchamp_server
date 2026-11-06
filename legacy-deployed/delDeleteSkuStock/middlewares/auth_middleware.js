// import admin from './firebase-service';

const functions = require("firebase-functions");
const admin = require("firebase-admin");

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

