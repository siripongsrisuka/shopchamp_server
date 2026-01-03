const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// routes
app.use("/test", require("./routes/test.routes"));


module.exports = app;
