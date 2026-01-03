
exports.stringDateTime = () => {
    const today = new Date();
    const cDateTime =
        today.getDate().toString().padStart(2,"0") + "/"+
        parseInt(today.getMonth()+1).toString().padStart(2,"0") +"/"+
        today.getFullYear().toString().padStart(4,"0")+" " +
        today.getHours().toString().padStart(2,"0")+":"+
        today.getMinutes().toString().padStart(2,"0")+":"+
        today.getSeconds().toString().padStart(2,"0");

    return cDateTime;  // 27/06/2021 00:25:26
};

exports.toUTC7 = (date = new Date()) => {
  // date is UTC
  const utcTime = date.getTime(); // milliseconds
  const utc7Time = utcTime + (7 * 60 * 60 * 1000); // shift 7 hours
  return new Date(utc7Time);
};


exports.stringTime = () => {
    const today = new Date();
    const cDateTime =
        // today.getDate().toString().padStart(2,"0") + "/"+
        // parseInt(today.getMonth()+1).toString().padStart(2,"0") +"/"+
        // today.getFullYear().toString().padStart(4,"0");
        today.getHours().toString().padStart(2,"0")+":"+
        today.getMinutes().toString().padStart(2,"0")+":"+
        today.getSeconds().toString().padStart(2,"0");

    return cDateTime;  //00:25:26
}

exports.setTimeZero = (date) => {

        let result = date;
        result.setHours(0);
        result.setMinutes(0);
        result.setSeconds(0);
        result.setMilliseconds(0)
    return result;  //for startDate
}
exports.setTimeZero2 = (date) => {

        let result = date;
        result.setHours(23);
        result.setMinutes(59);
        result.setSeconds(59);
        result.setMilliseconds(59)
    return result;  //for expireDate
}

exports.stringDtNumOnly = () => {
    const today = new Date();
    const cDateTime =
        today.getDate().toString().padStart(2,"0") +
        parseInt(today.getMonth()+1).toString().padStart(2,"0") +
        today.getFullYear().toString().padStart(4,"0")+
        today.getHours().toString().padStart(2,"0")+
        today.getMinutes().toString().padStart(2,"0")+
        today.getSeconds().toString().padStart(2,"0");

    return cDateTime;  // 27062021002526
}

exports.stringDtNumOnly2 = (today) => {
    // const today = new Date();
    const cDateTime =
        today.getFullYear().toString().padStart(4,"0")+
        parseInt(today.getMonth()+1).toString().padStart(2,"0") +
        today.getDate().toString().padStart(2,"0") + '-'+
        today.getHours().toString().padStart(2,"0")+
        today.getMinutes().toString().padStart(2,"0")+
        today.getSeconds().toString().padStart(2,"0");

    return cDateTime;  // 20210612002526
}

exports.stringDtNumOnly3 = (today = new Date()) => {
    // const today = new Date();
    const cDateTime =
        today.getDate().toString().padStart(2,"0") +
        parseInt(today.getMonth()+1).toString().padStart(2,"0") +
        today.getFullYear().toString().padStart(4,"0")+
        today.getHours().toString().padStart(2,"0")+
        today.getMinutes().toString().padStart(2,"0")+
        today.getSeconds().toString().padStart(2,"0")+
        today.getMilliseconds()

    return cDateTime;  // 27062021002526
}


exports.stringYMDHMS = () => {
    const today = new Date();
    const cDateTime =
        today.getFullYear().toString().padStart(4,"0")+
        parseInt(today.getMonth()+1).toString().padStart(2,"0") +
        today.getDate().toString().padStart(2,"0") +
        today.getHours().toString().padStart(2,"0")+
        today.getMinutes().toString().padStart(2,"0")+
        today.getSeconds().toString().padStart(2,"0");

    return cDateTime;  // 20210627002526
}

exports.stringYMD = (date) => {
    const cDateTime =
        date.getFullYear().toString().padStart(4,"0")+
        parseInt(date.getMonth()+1).toString().padStart(2,"0") +
        date.getDate().toString().padStart(2,"0") 

    return cDateTime;  // 20210627
}

exports.NumberYMD = (date) => {
    const cDateTime =
        date.getFullYear().toString().padStart(4,"0")+
        parseInt(date.getMonth()+1).toString().padStart(2,"0") +
        date.getDate().toString().padStart(2,"0") 

    return Number(cDateTime);  // 20210627
}

exports.stringYMDHMS3 = (day) => {
    const cDateTime =
        day.getFullYear().toString().padStart(4,"0")+
        parseInt(day.getMonth()+1).toString().padStart(2,"0") +
        day.getDate().toString().padStart(2,"0")

    return String(cDateTime);  // 20210627
}




exports.getMonth = (date) => {
    console.log((date|| new Date()).getMonth())
    return parseInt(new Date().getMonth()+1)
};


exports.stringDate = () => {
    const today = new Date();
    const cDate =
        today.getDate() + "/"+
        parseInt(today.getMonth()+1) +"/"+
        today.getFullYear();

    return cDate; // 27/06/2021 
}

exports.stringYMD2 = () => {
    const today = new Date();
    const Y = today.getFullYear().toString();
    const preM = parseInt(today.getMonth()+1).toString();
    const M = preM.length === 1 ? '0' + preM :preM;
    const D = today.getDate().toString();

    const YMD = Y + M + D;

    return YMD;
}

exports.MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  exports.stringDateTime3 = (today) => {
    // const today = new Date();
    let xx = 10
    if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '01'){
        xx = 'ม.ค.'
    } else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '02'){
        xx = 'ก.พ.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '03'){
        xx = 'มี.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '04'){
        xx = 'เม.ย.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '05'){
        xx = 'พ.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '06'){
        xx = 'มิ.ย.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '07'){
        xx = 'ก.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '08'){
        xx = 'ส.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '09'){
        xx = 'ก.ย.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '10'){
        xx = 'ต.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '11'){
        xx = 'พ.ย.'
    }else{
        xx = 'ธ.ค.'
    }

    let year = Number(today.getFullYear().toString().padStart(4,"0")) + 543
    const cDateTime =
        today.getDate().toString().padStart(2,"0") + "  "+
        xx +" "+
        year+"   " 
    return cDateTime;  // 27/06/2021 
}

exports.stringFullTime = (today) => {
    // const today = new Date();
    let xx = 10
    if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '01'){
        xx = 'ม.ค.'
    } else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '02'){
        xx = 'ก.พ.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '03'){
        xx = 'มี.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '04'){
        xx = 'เม.ย.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '05'){
        xx = 'พ.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '06'){
        xx = 'มิ.ย.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '07'){
        xx = 'ก.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '08'){
        xx = 'ส.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '09'){
        xx = 'ก.ย.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '10'){
        xx = 'ต.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '11'){
        xx = 'พ.ย.'
    }else{
        xx = 'ธ.ค.'
    }

    let year = Number(today.getFullYear().toString().padStart(4,"0")) + 543
    const cDateTime =
        today.getDate().toString().padStart(2,"0") + "  "+
        xx +" "+
        year+"   " +
        today.getHours().toString().padStart(2,"0")+":"+
        today.getMinutes().toString().padStart(2,"0")+":"+
        today.getSeconds().toString().padStart(2,"0");
    return cDateTime;  // 27/06/2021 
}

exports.stringFullDate = (today) => {
    // const today = new Date();
    let xx = 10
    if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '01'){
        xx = 'ม.ค.'
    } else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '02'){
        xx = 'ก.พ.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '03'){
        xx = 'มี.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '04'){
        xx = 'เม.ย.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '05'){
        xx = 'พ.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '06'){
        xx = 'มิ.ย.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '07'){
        xx = 'ก.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '08'){
        xx = 'ส.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '09'){
        xx = 'ก.ย.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '10'){
        xx = 'ต.ค.'
    }else if(parseInt(today.getMonth()+1).toString().padStart(2,"0") == '11'){
        xx = 'พ.ย.'
    }else{
        xx = 'ธ.ค.'
    }

    let year = Number(today.getFullYear().toString().padStart(4,"0")) + 543
    const cDateTime =
        today.getDate().toString().padStart(2,"0") + "  "+
        xx +" "+
        year+"   " 
    return cDateTime;  // 12/ม.ค./2021 
}


exports.minusDays = (date, days) => {
    var result = new Date(date);
    result.setDate(result.getDate() - days);
    return result;
}   //minusDays(new Date(), 14)

exports.minusYears = (date, years) => {
    var result = new Date(date);
    result.setFullYear(result.getFullYear() - years);
    return result;
};

exports.yearMonth = (today = new Date()) => {
    // const today = new Date();
    const cDateTime =
        today.getFullYear().toString().padStart(4,"0")+
        parseInt(today.getMonth()+1).toString().padStart(2,"0") 

    return cDateTime;  // 202211
}

exports.stringY= (day = new Date()) => {
    const Y = day.getFullYear().toString();
    return Y;
}


exports.stringReceiptNumber = (receipts) => {
    const date = new Date()
    const cDateTime =
        date.getFullYear().toString().padStart(4,"0")+"" +
        parseInt(date.getMonth()+1).toString().padStart(2,"0") +""+
        receipts.toString().padStart(6,"0")

    return cDateTime;  // 202309000123
}

exports.stringReceiptNumber_YMD = (receipts) => {
    const date = new Date();
    const cDateTime =
        date.getFullYear().toString().padStart(4, "0") + "" +
        (date.getMonth() + 1).toString().padStart(2, "0") + "" +
        date.getDate().toString().padStart(2, "0") + "" +
        receipts.toString().padStart(6, "0");

    return cDateTime;  // 20230915000123
}