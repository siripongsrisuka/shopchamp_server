const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch-commonjs");   // config adjust of "node-fetch" ,for compatible with all javascript,ESM,node version
const axios = require("axios");
const env = require("../env.json");
const timeout = require("connect-timeout");

const app = express();
app.use(cors({origin:true}));
// Increase the request timeout to 2 minutes (120 seconds)
app.use(timeout("300s"));
app.use((req, res, next) => {
    if (!req.timedout) next();
});


var db = admin.firestore(); // Initialize Firestore database

// Firestore and Storage initialization
const firestore = admin.firestore();
firestore.settings({
  retryWrites: true,      // Ensures writes are retried
  timeoutSeconds: 300     // Set timeout to 120 seconds
});
const bucket = admin.storage().bucket(); // ต้องไปเพิ่ม storage butket ที่ index.js

// Limit concurrent image processing to prevent memory issues
const MAX_CONCURRENT_DOWNLOADS = 10;
const BATCH_SIZE = 480; // Reduce from 500 to 400 to stay within Firestore limits
const BATCH_DELAY_MS = 100; // Delay between batch commits to prevent rate limits

// Function to download an image from a URL
async function downloadImage(imageUrl) {
  try {
    const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
    return { buffer: response.data, contentType: response.headers["content-type"] };
  } catch (error) {
    console.error("Failed to download image:", imageUrl, error.message);
    return null; // Prevents stopping execution on failure
  }
};

// Function to upload an image to Firebase Storage
async function uploadToFirebase(buffer, contentType, storagePath, originalShop) {
  try {
    const timestamp = Date.now();
    const fileName = `${originalShop}_${timestamp}.webp`;
    const fileRef = bucket.file(`${storagePath}${fileName}`);

    const downloadToken = require("crypto").randomUUID();
    await fileRef.save(buffer, {
      contentType: "image/webp",
      metadata: {
        metadata: { firebaseStorageDownloadTokens: downloadToken },
      },
    });

    return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileRef.name)}?alt=media&token=${downloadToken}`;
  } catch (error) {
    console.error("Error uploading to Firebase:", error.message);
    return "";
  }
};

async function processProducts(productDocs, nextShop) {
  const products = [];
  const allProduct = productDocs.docs.map(doc=>({...doc.data(), id:doc.id}));
  const productMap = new Map(allProduct.map(a=>[a.id,a.barcode]))
  for (let i = 0; i < productDocs.docs.length; i += MAX_CONCURRENT_DOWNLOADS) {
    const batch = productDocs.docs.slice(i, i + MAX_CONCURRENT_DOWNLOADS);

    const processedBatch = await Promise.all(
      batch.map(async (doc) => {
        const product = doc.data();

        // 🔹 Skip if product is marked deleted
        if (product.deleted === true || product.sku === 'delete') return null;

        product.shopId = nextShop;
        product.stock = 0;
        product.linkNext = product.linkNext?productMap.get(product.linkNext):'';

        // if (product.imageId && product.selfImage) {
        //   const image = await downloadImage(product.imageId);
        //   if (image) {
        //     product.imageId = await uploadToFirebase(
        //       image.buffer,
        //       image.contentType,
        //       "testClone/",
        //       nextShop
        //     );
        //   }
        // }

        return product;
      })
    );

    // 🔹 Filter out null items (deleted products)
    products.push(...processedBatch.filter(Boolean));
  }

  return products;
}

// Function to break an array into smaller chunks
function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

// Function to commit Firestore writes with delay to avoid rate limits
async function commitWithDelay(batches) {
  for (const batch of batches) {
    await batch.commit();
    await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS)); // Delay between batch commits
  }
}


// Main function to clone a shop
// ต้องโคลน 2  step เสมอ
app.post("/cloneShop", async (req, res) => {
  try {
    const { originalShop, nextShop } = req.body;
    // Step 1: Clone shop data
    const originalShopDoc = await firestore.collection("shop").doc(originalShop).get();
    if (!originalShopDoc.exists) {
      return res.status(404).send("Original shop not found");
    }

    // const { smartCategory, smartOption, smartKitchen, channel, BOMCategory, scanFoodPayment, scanFoodVat, scanFoodServiceCharge, rounding, payConfig } = originalShopDoc.data();
    // await firestore.collection("shop").doc(nextShop).set(
    //   { smartCategory, smartOption, smartKitchen, channel, BOMCategory, scanFoodPayment, scanFoodVat, scanFoodServiceCharge, rounding, payConfig },
    //   { merge: true }
    // );
    const { smartCategory } = originalShopDoc.data();
    await firestore.collection("shop").doc(nextShop).set(
      { smartCategory,  },
      { merge: true }
    );

    // Step 2: Fetch and clone products
    const productDocs = await firestore.collection("stock").where("shopId", "==", originalShop).get();
    if (productDocs.empty) {
      return res.status(200).send("No products to clone.");
    }

    // Step 3: Process images in controlled parallel batches
    const products = await processProducts(productDocs, nextShop);

    // Step 4: Batch write products to Firestore in chunks
    const productChunks = chunkArray(products, BATCH_SIZE);
    await commitWithDelay(
      productChunks.map((chunk) => {
        const batch = firestore.batch();
        chunk.forEach((product) => {
          const newDocRef = firestore.collection("stock").doc();
          batch.set(newDocRef, product);
        });
        return batch;
      })
    );

    // // Step 5: Fetch and clone products
    const stockLinkDocs = await firestore.collection("stockLink").where("shopId", "==", originalShop).get();
    if (!stockLinkDocs.empty) {
          const stockLinks = stockLinkDocs.docs.map(doc=>({...doc.data(), shopId:nextShop }));


      // Step 6: Batch write stockLinks to Firestore in chunks
      const stockLinkChunks = chunkArray(stockLinks, BATCH_SIZE);
      await commitWithDelay(
        stockLinkChunks.map((chunk) => {
          const batch = firestore.batch();
          chunk.forEach((stockLink) => {
            const newDocRef = firestore.collection("stockLink").doc();
            batch.set(newDocRef, {...stockLink, id:newDocRef.id});
          });
          return batch;
        })
      );
    }



    //     // Step 7: Fetch and clone products
    const supplierDocs = await firestore.collection("supplier").where("shopId", "==", originalShop).get();
    if (!supplierDocs.empty) {
          const suppliers = supplierDocs.docs.map(doc=>({...doc.data(), shopId:nextShop }));
        // Step 6: Batch write suppliers to Firestore in chunks
        const supplierChunks = chunkArray(suppliers, BATCH_SIZE);
        await commitWithDelay(
          supplierChunks.map((chunk) => {
            const batch = firestore.batch();
            chunk.forEach((supplier) => {
              const newDocRef = firestore.collection("supplier").doc();
              batch.set(newDocRef, {...supplier, id:newDocRef.id});
            });
            return batch;
          })
        );
    }



    res.status(200).send(`Cloned ${products.length} products successfully!`);
  } catch (error) {
    console.error("Error cloning shop:", error.message);
    res.status(500).send("An error occurred while cloning the shop.");
  }
});

app.post("/cloneShop2", async (req, res) => {
  try {
    const { shopId } = req.body;
    // const shopId = 'Yu7Myh3pWMpj83drRY6n';
    const query = await db.collection('stock').where('shopId', '==', shopId).select('barcode','linkNext').get();
    const products = query.docs.map(doc=>({...doc.data(), id:doc.id}));
    const productMap = new Map(products.map(a=>[a.barcode,a.id]));
    const productWithLinkNexts = products.filter(a=>a.linkNext);

    const BATCH_SIZE = 500;

    // for (let i = 0; i < productWithLinkNexts.length; i += BATCH_SIZE) {
    //   const chunk = productWithLinkNexts.slice(i, i + BATCH_SIZE);
    //   const batch = db.batch();

    //   chunk.forEach(item => {
    //     const linkNext = item.linkNext?
    //       productMap.has(item.linkNext)
    //         ?productMap.get(item.linkNext)
    //         :'':'';
    //     batch.update(db.collection('stock').doc(item.id),{ linkNext });
    //   });

    //   await batch.commit();
    //   updatedCount += chunk.length;
    //   console.log(`Update batch ${i / BATCH_SIZE + 1}: ${chunk.length} docs`);
    // };

       const productChunks = chunkArray(productWithLinkNexts, BATCH_SIZE);
          await commitWithDelay(
            productChunks.map((chunk) => {
              const batch = firestore.batch();
              chunk.forEach((product) => {
                const linkNext = product.linkNext?
                  productMap.has(product.linkNext)
                    ?productMap.get(product.linkNext)
                    :'':'';
                batch.update(db.collection('stock').doc(product.id),{ linkNext });
              });
              return batch;
            })
      );

    const stockLinkDocs = await firestore.collection("stockLink").where("shopId", "==", shopId).select('stockLink').get();
        if (!stockLinkDocs.empty) {
          const stockLinks = stockLinkDocs.docs.map(doc=>({...doc.data(), id:doc.id }));


      // Step 6: Batch write stockLinks to Firestore in chunks
      const stockLinkChunks = chunkArray(stockLinks, BATCH_SIZE);
      await commitWithDelay(
        stockLinkChunks.map((chunk) => {
          const batch = firestore.batch();
          chunk.forEach((item) => {
            const stockLink = item.stockLink.map(a=>({...a,id:productMap.has(a.barcode)?productMap.get(a.barcode):a.id}))
            batch.update(db.collection('stockLink').doc(item.id), { stockLink });
          });
          return batch;
        })
      );
    }

    res.status(200).send(`✅ Update ${productWithLinkNexts.length} products successfully!`);
  } catch (error) {
    console.error("❌ Error updating products:", error.message);
    res.status(500).send("An error occurred while updating products.");
  }
});

app.post("/deleteAllProducts", async (req, res) => {
  try {
    const shopId = 'Yu7Myh3pWMpj83drRY6n';
    const query = await db.collection('stock').where('shopId', '==', shopId).select('barcode').get();
    const docs = query.docs;
    const total = docs.length;

    console.log(`Found ${total} products to delete.`);

    const BATCH_SIZE = 500;
    let deletedCount = 0;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const chunk = docs.slice(i, i + BATCH_SIZE);
      const batch = db.batch();

      chunk.forEach(doc => {
        batch.delete(db.collection('stock').doc(doc.id));
      });

      await batch.commit();
      deletedCount += chunk.length;
      console.log(`Deleted batch ${i / BATCH_SIZE + 1}: ${chunk.length} docs`);
    }

    res.status(200).send(`✅ Deleted ${deletedCount} products successfully!`);
  } catch (error) {
    console.error("❌ Error deleting products:", error.message);
    res.status(500).send("An error occurred while deleting products.");
  }
});

module.exports = app;

