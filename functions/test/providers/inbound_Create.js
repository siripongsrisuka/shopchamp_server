

const { db } = require("../../firebase");
const { toUTC7, stringReceiptNumber, stringYMDHMS3 } = require("../../helpers/dateTime");
const { formatTime } = require("../../helpers/functions");

exports.inbound_Create = async (req, res) => {
  const { 
   
  } = req.body;
  try {
    const timestamp = new Date();
    const timethai = toUTC7(timestamp);
    const billDate = stringYMDHMS3(timethai);
    const latestfetchTime = new Date()
    // ข้อมูลการรับเข้า

        const stockSnapshot = await db.collection('stock')
            .where('shopId', '==', '922gsIyiAOtG73mo3DL9')
            .where('updateTime', '>', new Date(formatTime(latestfetchTime)))
            .get();

        const products = stockSnapshot.docs.map(doc => {
          const { timestamp, updateTime, ...rest } = doc.data()
          return {
            timestamp:formatTime(timestamp),
            updateTime:formatTime(updateTime),
            ...rest,
            id:doc.id
          }
        });

        // Get the latest updateTime
        const latestTime = products.length > 0 ? normalSort('updateTime',products)[0]?.updateTime : latestfetchTime;


    res.status(200).send({ latestTime, products});
  } catch (err) {
    res.status(500).send({ success: false, error: err.toString() });
  }
};



