async function getBardcodeAPIRef(objBarcode){
    let data = [];

    // const barcodeString = barcode.map(({barcode})=>(barcode));
    // const barcodeString = barcode.map(({barcode})=>(barcode)).slice(0,2);
    // const barcodeString = objBarcode.map(({barcode})=>(barcode)).slice(106).slice(0,20);
    // const barcodeString = objBarcode.map(({barcode})=>(barcode)).slice(106).slice(0,20);
    const barcodeString = objBarcode.map(({barcode})=>(barcode)).slice(106).slice(0,99);
    // const barcodeString = barcode.map(({barcode})=>(barcode)).slice(106).slice(0,1000).filter(barcode => barcode.length >= 6);

    console.log('barcodeString.length')
    console.log(barcodeString.length)
    console.log('barcodeString')
    console.log(barcodeString)
    

    // console.log('barcodeString')
    // console.log(typeof barcodeString)
    // console.log(barcodeString)

    // // test
    // return res.status(200).send(barcodeString);

    // Split billDate into chunks of 10 elements each
    const chunkSize = 10;
    const barcodeChunks = [];
    for (let i = 0; i < barcodeString.length; i += chunkSize) {
        barcodeChunks.push(barcodeString.slice(i, i + chunkSize));
    }


    // // test
    // console.log('barcodeChunks')
    // console.log(typeof barcodeChunks)
    // console.log(barcodeChunks)
    // return res.status(200).send(barcodeChunks);

    // Use Promise.all to make multiple queries
    const promises = barcodeChunks.map(async (chunk) => {
        // return res.status(200).send(chunk)

        chunk.map(async barcode => {
            const apiReq = {
                method: 'POST',
                url: `https://rms.cdar.nielseniq.com/barter-backend-service/btr/api/barcodeLookup`,
                headers: {
                    "Authorization" : `Bearer eyJraWQiOiIzcW83QS0wbFE2R3Buck9OLUFiMENXUk9lNkFTSnB3SHB2VmVYQm5Hdkg0IiwiYWxnIjoiUlMyNTYifQ.eyJ2ZXIiOjEsImp0aSI6IkFULm10SVNES05iT0d3RWFacjdqeFpFVVd2NGJ6MFBCMk9XTHZURHdKbVBvN2siLCJpc3MiOiJodHRwczovL2xvZ2luLmlkZW50aXR5Lm5pZWxzZW5pcS5jb20vb2F1dGgyL2F1czJqaTRubm9oaEd2dmJWNHg3IiwiYXVkIjoiUG9zVGVybWluYWwiLCJpYXQiOjE3MDc4MzIzNDYsImV4cCI6MTcwNzgzNTk0NiwiY2lkIjoiMG9hZmR5dDR6NnpTZWZmb1E0eDciLCJzY3AiOlsiY2NzY29wZSJdLCJzdWIiOiIwb2FmZHl0NHo2elNlZmZvUTR4NyJ9.RAcfB3gTEJxsNJ-X1IEJSfacZe51pCBfDLMypW-RWbUXcnwUZzzEqYphoh4SYl8KrRo8Qa4KjuyevVzaqF4AShf4bIb088g2mxUeapP_SCwyXBpxsXzuj1tFLN5cSE9Sf3HuURUIoDtyfETcZgzmV7URelZlC0jRQb1JtJ2XTIt0vNT98OHnm8LHgDmgKjfTrKkhLkrOUbEv61y58gmZfSl8cCiZlXydb1Q4E44WbGKq_KLKp1eP4Cwu1a5x32zKTcU1WJmO7skogcWdLAVJmpaxPxkOUjgA-iSOD7YPzQBfvBvJgEm6bdm_06z_nuTMJDCQc8Ey4kDddd-2wl5yYQ`,
                    "x-region-id":"APAC",
                    "x-vendor-id":"SHOPCHAMP",
                    "x-store-id":"d8BoBZl+LoXfuT9biYAdZnZE68l3LTPg",
                    "x-auth-user-type":"pos"
                },
                data: { // ("body")
                    country: "th",
                    barcode: barcode
                    // barcode: chunk
                    // barcode: "00 8859361300258"
                    // barcode: ''
                    // barcode: "8850029022949"    // in niq
                    // barcode: "18850267118227"   // not in niq
                }
            };                    


            try{
                const response = await axios.request(apiReq);
                if (response.status === 200){
                    if(response?.data?.data) data.push(response?.data?.data)
                }else {

                }
            }catch(err){
                console.log('make_error_chunk')
                console.log(chunk)
                functions.logger.error("function:getBarcodeRef:getBardcodeAPIRef:catch",err);
                res.status(500).send({ message: "getBarcodeRef:getBardcodeAPIRef:Internal Server Error",error:err});
            }
        })
        // for(barcode of chunk){
        //     const apiReq = {
        //         method: 'POST',
        //         url: `https://rms.cdar.nielseniq.com/barter-backend-service/btr/api/barcodeLookup`,
        //         headers: {
        //             "Authorization" : `Bearer eyJraWQiOiIzcW83QS0wbFE2R3Buck9OLUFiMENXUk9lNkFTSnB3SHB2VmVYQm5Hdkg0IiwiYWxnIjoiUlMyNTYifQ.eyJ2ZXIiOjEsImp0aSI6IkFULm10SVNES05iT0d3RWFacjdqeFpFVVd2NGJ6MFBCMk9XTHZURHdKbVBvN2siLCJpc3MiOiJodHRwczovL2xvZ2luLmlkZW50aXR5Lm5pZWxzZW5pcS5jb20vb2F1dGgyL2F1czJqaTRubm9oaEd2dmJWNHg3IiwiYXVkIjoiUG9zVGVybWluYWwiLCJpYXQiOjE3MDc4MzIzNDYsImV4cCI6MTcwNzgzNTk0NiwiY2lkIjoiMG9hZmR5dDR6NnpTZWZmb1E0eDciLCJzY3AiOlsiY2NzY29wZSJdLCJzdWIiOiIwb2FmZHl0NHo2elNlZmZvUTR4NyJ9.RAcfB3gTEJxsNJ-X1IEJSfacZe51pCBfDLMypW-RWbUXcnwUZzzEqYphoh4SYl8KrRo8Qa4KjuyevVzaqF4AShf4bIb088g2mxUeapP_SCwyXBpxsXzuj1tFLN5cSE9Sf3HuURUIoDtyfETcZgzmV7URelZlC0jRQb1JtJ2XTIt0vNT98OHnm8LHgDmgKjfTrKkhLkrOUbEv61y58gmZfSl8cCiZlXydb1Q4E44WbGKq_KLKp1eP4Cwu1a5x32zKTcU1WJmO7skogcWdLAVJmpaxPxkOUjgA-iSOD7YPzQBfvBvJgEm6bdm_06z_nuTMJDCQc8Ey4kDddd-2wl5yYQ`,
        //             "x-region-id":"APAC",
        //             "x-vendor-id":"SHOPCHAMP",
        //             "x-store-id":"d8BoBZl+LoXfuT9biYAdZnZE68l3LTPg",
        //             "x-auth-user-type":"pos"
        //         },
        //         data: { // ("body")
        //             country: "th",
        //             barcode: barcode
        //             // barcode: chunk
        //             // barcode: "00 8859361300258"
        //             // barcode: ''
        //             // barcode: "8850029022949"    // in niq
        //             // barcode: "18850267118227"   // not in niq
        //         }
        //     };                    


        //     try{
        //         const response = await axios.request(apiReq);
        //         if (response.status === 200){
        //             if(response?.data?.data) data.push(response?.data?.data)
        //         }else {

        //         }
        //     }catch(err){
        //         console.log('make_error_chunk')
        //         console.log(chunk)
        //         functions.logger.error("function:getBarcodeRef:getBardcodeAPIRef:catch",err);
        //         res.status(500).send({ message: "getBarcodeRef:getBardcodeAPIRef:Internal Server Error",error:err});
        //     }
        // }


    });

    // Wait for all queries to complete
    await Promise.all(promises);


    // const response = await axios.request(apiReq);
    // if (response.status === 200){
    //     if(response?.data?.data) data.push(response?.data?.data)
    // }

    return data;
}