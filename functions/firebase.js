const admin = require("firebase-admin");

// สำหรับ Firebase Functions
// ❌ ไม่ใช้ serviceAccountKey.json
// ✅ ใช้ default service account อัตโนมัติ
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

module.exports = { admin, db };
