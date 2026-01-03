const express = require("express");
const { inbound_Create } = require("../providers/inbound_Create");
const router = express.Router();


router.post("/create", inbound_Create);


module.exports = router;
