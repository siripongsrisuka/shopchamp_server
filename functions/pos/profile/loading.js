// pos/profile/loading — ตอนเปิดแอป: ตัวตน ร้าน สิทธิ์ อัปเดตแอป (ก้อน 4 · DEV-0001)
//
// สัญญา: shopchamp-center/api/profile.loading.yaml · แทนการอ่าน Firestore ตรงของ `app:screens/LoadingScreen.js:49-90`
// รูป: factory (deps) => handler(req, res) · deps: now · ยังไม่ export จาก index.js และยังไม่ deploy
// route ผ่าน checkIfAuthenticated เท่านั้น (ยังไม่รู้ร้าน) · ตัวตน = req.auth.uid · ร้าน = profile.currentLogin.shopId ในฐาน
// อ่านอย่างเดียว: ❌ ไม่เขียน currentLogin กลับแบบแอปเก่า (LoadingScreen.js:87)
//   อ่าน profile/{uid} · admin/updateShopchamp · shop where shopId == · admin/adminConfig (ครั้งเดียว เมื่อเจอร้าน)
// เทส: loading.test.js (ของที่ชุด case ของสัญญาไม่คุม)
// ข้อมูลร้านที่คืน = รายการช่องที่อนุญาต (allowlist) · ❌ humanResource ดิบ (รหัสแคชเชียร์ข้อความล้วน #13) · line · taxCustomer
//   ช่องเวลาของ Firestore แปลงเป็นข้อความ ISO ก่อนส่ง
// ❌ ห้าม require SDK ตัวจริงตรงนี้ (harness ปัดถ้าโหลด firebase-admin) · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { ProfileLoadingRequest } = require("@shopchamp/schema");
const { ok, fail, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { resolveShopAccess, INITIAL_RIGHTS } = require("../_shared/auth");

// ช่องของ doc ร้านที่ส่งให้แอปได้ (ตัวตนร้าน · จุดขาย · แพ็กเกจ · ตั้งค่าขาย)
//   ช่องที่ไม่อยู่ในนี้ไม่ออก ⇒ ช่องใหม่ที่ใครเพิ่มในฐานพรุ่งนี้ ไม่หลุดออก API เอง (fail-closed)
const SHOP_FIELDS = Object.freeze([
  "shopId", "scShopId", "name", "tel", "address", "logo", "franchiseId", "wholesaleId",
  "receiptPattern", "amendBill", "POSs", "vip", "shift", "position",
  "shopchampPayment", "rounding", "shopchampVat", "tax", "receipt",
  "smartCategory", "smartPoint", "creditPoint", "cutOff",
]);
// ช่องของพนักงานแต่ละคนที่ส่งได้ · ❌ password (รหัสแคชเชียร์) · rights ของคนอื่น
const STAFF_FIELDS = Object.freeze(["id", "name", "position", "status", "owner"]);
const UPDATE_FIELDS = Object.freeze(["lastedVersion", "isMustUpdate", "appUrl", "detail"]);

const isNonEmptyString = (v) => typeof v === "string" && v !== "";
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** toPlain(v) — แปลง Timestamp (มี toDate) เป็น ISO ทั้งก้อน · ค่าอื่นคงเดิม */
function toPlain(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === "object" && typeof v.toDate === "function") {
    const d = v.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = toPlain(v[k]);
    return out;
  }
  return v;
}

function pick(src, fields) {
  const out = {};
  if (!isPlainObject(src)) return out;
  for (const f of fields) if (src[f] !== undefined) out[f] = toPlain(src[f]);
  return out;
}

/** shopView(docId, shop) — ข้อมูลร้านที่ส่งให้แอป · id = doc id · shopId = field (ร้านเก่า 2 ค่านี้ต่างกันได้) */
function shopView(docId, shop) {
  const hr = Array.isArray(shop.humanResource) ? shop.humanResource : [];
  return {
    ...pick(shop, SHOP_FIELDS),
    id: docId,
    receiptPattern: shop.receiptPattern || "month",
    staff: hr.filter(isPlainObject).map((p) => pick(p, STAFF_FIELDS)),
  };
}

function profileView(p) {
  return {
    name: typeof p.name === "string" ? p.name : "",
    tel: typeof p.tel === "string" ? p.tel : "",
    email: typeof p.email === "string" ? p.email : "",
    imageId: typeof p.imageId === "string" ? p.imageId : "",
    port: Array.isArray(p.port) ? toPlain(p.port) : [],
  };
}

function updateView(updateDoc, platform) {
  const u = isPlainObject(updateDoc) && isPlainObject(updateDoc[platform]) ? updateDoc[platform] : null;
  return u ? pick(u, UPDATE_FIELDS) : null;
}

function loading(deps) {
  return async function handler(req, res) {
    const uid = req && req.auth && isNonEmptyString(req.auth.uid) ? req.auth.uid : "";
    if (!uid) return fail(res, 401, "no_auth");
    const input = parseOr400(ProfileLoadingRequest, req.body, res);
    if (!input) return;

    try {
      const now = await readNow(deps);
      const [profileSnap, updateSnap] = await Promise.all([
        db.collection("profile").doc(uid).get(),
        db.collection("admin").doc("updateShopchamp").get(),
      ]);
      if (!profileSnap.exists) return fail(res, 404, "profile_not_found", "ไม่พบข้อมูลบัญชี");

      const profile = profileSnap.data() || {};
      const base = {
        uid,
        serverTime: now.toISOString(),
        profile: profileView(profile),
        update: updateView(updateSnap.exists ? updateSnap.data() : null, input.platform),
      };

      const shopField = isPlainObject(profile.currentLogin) && isNonEmptyString(profile.currentLogin.shopId)
        ? profile.currentLogin.shopId : "";
      if (!shopField) return ok(res, { ...base, access: { status: "no_shop" } });

      const shopSnap = await db.collection("shop").where("shopId", "==", shopField).get();
      // แอปเก่าเดิน forEach แล้วเก็บตัวสุดท้าย (LoadingScreen.js:66-68) ⇒ ใช้ตัวสุดท้ายเหมือนกัน
      const shopDoc = shopSnap.empty ? null : shopSnap.docs[shopSnap.docs.length - 1];
      const shop = shopDoc ? shopDoc.data() : null;
      if (!isPlainObject(shop)) return ok(res, { ...base, access: { status: "shop_not_found" } });

      // ทีมงานมาก่อนสมาชิก (ตัดสินที่ _shared/auth.js › resolveShopAccess · แอปเก่า LoadingScreen.js:63,77,83)
      //   ทีมงานที่บังเอิญเป็นพนักงานในร้านได้ owner + byAdmin เหมือนทุก route (ผลตรวจ chunk4-verify/profile.loading.md W1)
      const adminConfig = () => db.collection("admin").doc("adminConfig").get().then((s) => (s.exists ? s.data() : null));
      const r = await resolveShopAccess({ shopDocId: shopDoc.id, shop, uid, now, adminConfig });
      if (!r.ok) {
        const reason = r.extra && r.extra.reason === "inactive" ? "inactive" : "not_a_member";
        return ok(res, { ...base, access: { status: reason } });
      }

      const a = r.access;
      // เจ้าของและทีมงานได้ initialRights ทั้งชุด เหมือนที่แอปเก่าเขียนลง currentLogin.rights (LoadingScreen.js:84)
      const access = {
        status: "active",
        role: a.role,
        rights: a.role === "owner" ? [...INITIAL_RIGHTS] : [...a.rights],
        ...(a.byAdmin === true ? { byAdmin: true } : {}),
      };
      return ok(res, { ...base, access, shop: shopView(shopDoc.id, shop) });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { loading, shopView, toPlain, SHOP_FIELDS, STAFF_FIELDS };
