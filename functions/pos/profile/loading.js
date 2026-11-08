// pos/profile/loading — ตอนเปิดแอป: ตัวตน ร้าน สิทธิ์ อัปเดตแอป (ก้อน 4 · DEV-0001)
//
// สัญญา: shopchamp-center/api/profile.loading.yaml · แทนการอ่าน Firestore ตรงของ `app:screens/LoadingScreen.js:49-90`
// รูป: factory (deps) => handler(req, res) · deps: now · ยังไม่ export จาก index.js และยังไม่ deploy
// route ผ่าน checkIfAuthenticated เท่านั้น (ยังไม่รู้ร้าน) · ตัวตน = req.auth.uid · ร้าน = profile.currentLogin.shopId ในฐาน
// อ่านอย่างเดียว: ❌ ไม่เขียน currentLogin กลับแบบแอปเก่า (LoadingScreen.js:87)
//   อ่าน profile/{uid} · admin/updateShopchamp · admin/adminConfig (โฆษณาอย่างเดียว) · watcher/roster (ตัดสินทีมงาน) · shop where shopId ==
// ทีมงาน (DEV-0001 watcher · Pack เคาะ 2026-11-07 ข้อ 9): คำตอบมี staffRole 'watcher'|'root'|'none' ทุกครั้งที่มี profile
//   แอปใหม่ใช้ธงนี้แทนการอ่าน admin/adminConfig เอง · ❌ adminConfig ไม่ใช้ตัดสินทีมงานแล้ว (uid ใน adminConfig แต่ไม่อยู่ใน roster = ไม่ใช่ทีมงาน)
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
const WR = require("../_shared/watcherRoster");

// ช่องของ doc ร้านที่ส่งให้แอปได้ (ตัวตนร้าน · จุดขาย · แพ็กเกจ · ตั้งค่าขาย)
//   ช่องที่ไม่อยู่ในนี้ไม่ออก ⇒ ช่องใหม่ที่ใครเพิ่มในฐานพรุ่งนี้ ไม่หลุดออก API เอง (fail-closed)
const SHOP_FIELDS = Object.freeze([
  "shopId", "scShopId", "name", "tel", "address", "logo", "franchiseId", "wholesaleId",
  "receiptPattern", "amendBill", "POSs", "vip", "shift", "position",
  "shopchampPayment", "rounding", "shopchampVat", "tax", "receipt",
  "smartCategory", "smartPoint", "creditPoint", "cutOff",
  // A-2 (Pack เคาะ 2026-11-06 คงแบบแอปเก่า): ช่องที่แอปเก่าอ่านจากก้อนร้าน (main3 src/config/initialShop.js · ผู้อ่านตรวจด้วย git grep main3)
  //   ❌ lineNoti lineUsers (ยังไม่เปิดดูของจริงว่ามี token ไหม) · ❌ line taxCustomer humanResource ดิบ (เหมือนเดิม)
  "smartCoupon", "smartReward", "categoryExpense", "soundPlayers", "soundStatus", "customerAds",
  "imageUrl", "imageLimit", "imageMore", "totalMember", "printers", "payment", "receiptPay", "smartAddress",
  "notiImport", "notiShift", "notiStaff", "notiStock", "notiSummary", "notiCancelBill", "notiCheckin", "notiCredit", "notiRequisition",
  // จอลูกค้าวิดีโอ (DEV-0001 · Pack สั่ง 2026-11-08): ช่องใหม่ แอปเก่าไม่อ่าน · ไม่มีในฐาน = ไม่มี key (แอปใหม่ถือว่า mode image · วิดีโอว่าง)
  "customerAdsVideo", "customerAdsMode",
  // ลำดับช่องทางชำระเงินบนจอตั้งค่า (DEV-0001 · Pack สั่ง 2026-11-08): ช่องใหม่ แอปเก่าไม่อ่าน · ไม่มีในฐาน = ไม่มี key
  "paymentDisplayOrder",
]);
// ช่องของพนักงานแต่ละคนที่ส่งได้ · ❌ password (รหัสแคชเชียร์) · rights ของคนอื่น
const STAFF_FIELDS = Object.freeze(["id", "name", "position", "status", "owner"]);
// A-3: isPackageOn แบบแอปเก่า (main3 LoadingScreen.js:57,192 · ใช้ที่ HomeScreen.js:175)
const UPDATE_FIELDS = Object.freeze(["lastedVersion", "isMustUpdate", "appUrl", "detail", "isPackageOn"]);
// B-3 (agent เลือก): จาก admin/adminConfig ส่งเฉพาะ 2 ช่องที่แอปเก่าอ่าน (redux/adminSlice.js:38-45) · ❌ รายชื่อ admin ไม่ออกเด็ดขาด
const ADMIN_CONFIG_FIELDS = Object.freeze(["mainAds", "screenVedios"]);

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

/** adminConfigView(cfg) — {mainAds, screenVedios} ที่มีจริง · ไม่มี doc = null (ไม่ส่ง key) */
function adminConfigView(cfg) {
  return isPlainObject(cfg) ? pick(cfg, ADMIN_CONFIG_FIELDS) : null;
}

function loading(deps) {
  return async function handler(req, res) {
    const uid = req && req.auth && isNonEmptyString(req.auth.uid) ? req.auth.uid : "";
    if (!uid) return fail(res, 401, "no_auth");
    const input = parseOr400(ProfileLoadingRequest, req.body, res);
    if (!input) return;

    try {
      const now = await readNow(deps);
      // adminConfig = โฆษณาในคำตอบ (B-3) อย่างเดียว · ทีมงานตัดสินจาก watcher/roster (อ่านครั้งเดียวต่อคำขอ)
      const [profileSnap, updateSnap, configSnap, rosterSnap] = await Promise.all([
        db.collection("profile").doc(uid).get(),
        db.collection("admin").doc("updateShopchamp").get(),
        db.collection("admin").doc("adminConfig").get(),
        WR.rosterRef(db).get(),
      ]);
      const cfg = configSnap.exists ? configSnap.data() : null;
      const roster = WR.snapToRoster(rosterSnap);
      if (!profileSnap.exists) return fail(res, 404, "profile_not_found", "ไม่พบข้อมูลบัญชี");

      const profile = profileSnap.data() || {};
      const base = {
        uid,
        serverTime: now.toISOString(),
        profile: profileView(profile),
        // B-2 (agent เลือก): ไม่มี doc/ไม่มีแพลตฟอร์มนี้ = update:null · แอปใหม่ข้ามการเตือนอัปเดต (แอปเก่าค้างหน้าโหลด)
        update: updateView(updateSnap.exists ? updateSnap.data() : null, input.platform),
        // ธงทีมงานจาก server (แอปใหม่/เว็บใช้แทนการอ่าน adminConfig) · ทะเบียนไม่มี/ว่าง = 'none'
        staffRole: WR.staffRoleOf(roster, uid),
      };
      const adminView = adminConfigView(cfg);
      if (adminView) base.adminConfig = adminView;

      const shopField = isPlainObject(profile.currentLogin) && isNonEmptyString(profile.currentLogin.shopId)
        ? profile.currentLogin.shopId : "";
      if (!shopField) return ok(res, { ...base, access: { status: "no_shop" } });

      const shopSnap = await db.collection("shop").where("shopId", "==", shopField).get();
      // แอปเก่าเดิน forEach แล้วเก็บตัวสุดท้าย (LoadingScreen.js:66-68) ⇒ ใช้ตัวสุดท้ายเหมือนกัน
      const shopDoc = shopSnap.empty ? null : shopSnap.docs[shopSnap.docs.length - 1];
      const shop = shopDoc ? shopDoc.data() : null;
      if (!isPlainObject(shop)) return ok(res, { ...base, access: { status: "shop_not_found" } });

      // root มาก่อนสมาชิก · watcher หลังสมาชิก (ตัดสินที่ _shared/auth.js › resolveShopAccess ตัวเดียวกับทุก route)
      //   root ที่บังเอิญเป็นพนักงานในร้านได้ owner + byAdmin + root · watcher ที่เป็นพนักงาน active ได้สิทธิ์ตามแถวตัวเอง
      const r = await resolveShopAccess({ shopDocId: shopDoc.id, shop, uid, now, roster });
      if (!r.ok) {
        const reason = r.extra && r.extra.reason === "inactive" ? "inactive" : "not_a_member";
        return ok(res, { ...base, access: { status: reason } });
      }

      const a = r.access;
      // เจ้าของและทีมงานได้ initialRights ทั้งชุด เหมือนที่แอปเก่าเขียนลง currentLogin.rights (LoadingScreen.js:84)
      //   watcher เห็นทุกเมนู (ชุดเต็ม) แต่ readOnly:true ⇒ จอซ่อนปุ่มเขียน · server ปัดเขียน 403 watcher_read_only อยู่ดี
      const access = {
        status: "active",
        role: a.role,
        rights: a.role === "owner" ? [...INITIAL_RIGHTS] : [...a.rights],
        ...(a.byAdmin === true ? { byAdmin: true, root: true } : {}),
        ...(a.watcher === true ? { watcher: true, readOnly: true } : {}),
      };
      return ok(res, { ...base, access, shop: shopView(shopDoc.id, shop) });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { loading, shopView, toPlain, adminConfigView, SHOP_FIELDS, STAFF_FIELDS, UPDATE_FIELDS, ADMIN_CONFIG_FIELDS };
