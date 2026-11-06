// pos/_shared/auth.js — ด่านตัวตนและด่านร้านของทุก route ใน pos (ก้อน 4 · DEV-0001)
//
// ยกท่าจากพี่น้อง (`middlewares/auth_middleware.js` verifyIdToken(token,true) · `claude/_shared/shopAccess.js` แกน requireShopAccess)
//   ตัดชั้น watcher/root ออก · กติกาเข้าร้านใช้ของแอปเก่าบ้านนี้ (`shopchamp_app` src/screens/LoadingScreen.js:62-90 · WelcomeScreen.js:116-145)
//   ❌ ใช้ functions/middlewares/auth_middleware.js ไม่ได้ (แช่แข็ง + require env.json)
//
// middleware (route ต่อ 2 ตัวนี้ตามลำดับ · harness ไม่รัน middleware ⇒ เทสอยู่ที่ auth.test.js):
//   checkIfAuthenticated(req,res,next)
//     Authorization: Bearer <idToken> → verifyIdToken(token, true) (ตรวจการเพิกถอนด้วย)
//     ไม่มี/ไม่ผ่าน → 401 {ok:false, error:"no_auth"} · ผ่าน → req.auth = {uid, email}
//   requireShopAccess(req,res,next)   ร้านเป้าหมาย = body.shopId = shop **doc id**
//     body.shopId ไม่มี/รูปผิด → 400 missing_shop_id · ไม่มี req.auth → 401 no_auth
//     ① shop/{shopId} ไม่มี → 404 shop_not_found
//     ② ผู้เรียกอยู่ใน shop.humanResource และ status 'active'
//        คนที่ไม่ใช่ index 0 นับ active ได้เมื่อแพ็กเกจ staff (แถวแรก) ยังไม่หมด ไม่งั้นถือเป็น inActive (กติกาแอปเก่า)
//        → req.shopAccess = {shopId, uid, role:'owner'|'staff', rights}   owner = position มี '001'
//          rights: staff = rights ของคนนั้น · owner = [] (เจ้าของผ่านทุกสิทธิ์ด้วย hasRight ไม่ต้องดู rights)
//     ③ ไม่ผ่าน ② แต่ uid อยู่ใน admin/adminConfig.admin (ทีมงาน Shopchamp · Pack เคาะ 2026-11-06 ข้อ 3-2)
//        → req.shopAccess = {shopId, uid, role:'owner', rights:[], byAdmin:true}
//        doc admin/adminConfig ไม่มี หรือช่อง admin ไม่ใช่ array = ไม่มีใครเป็นทีมงาน (fail-closed)
//     ④ ไม่ผ่านทั้งคู่ → 403 {ok:false, error:"not_shop_member", reason:'not_a_member'|'inactive'}
//
// ในตัว handler (ด่านซ้ำ เพราะ harness ส่ง req.shopAccess มาเอง):
//   callerAccess(req, body.shopId) → ไม่มี req.shopAccess = 401 no_shop_access · body.shopId ≠ ร้านที่ผ่านด่าน = 403 wrong_shop
//   checkOwnedDoc('bill', data, shopRef) → ไม่มี = 404 bill_not_found · ร้านอื่น = 409 bill_other_shop (ไม่คืนเนื้อ)
//   adminTrail(access) ใส่ทุกเอกสารที่เขียน · adminFlag(access) ใส่คำตอบ 2xx
"use strict";

const { deny, sendDeny, fail } = require("./respond");
const { readNow } = require("./deps");
const { isStaffPackageActive } = require("./premium");

const OWNER_POSITION = "001";
// สิทธิ์เต็มชุดของเจ้าของ · คัดจาก shopchamp_app/src/config/initialRights.js (มี '128' ซ้ำ 2 ตัวตามต้นฉบับ)
//   profile.loading คืนชุดนี้ให้เจ้าของและทีมงาน (แอปเก่าเขียน currentLogin.rights = initialRights)
const INITIAL_RIGHTS = Object.freeze([
  "100", "101", "102", "103", "104", "105", "106", "107", "108", "109", "110",
  "111", "112", "113", "114", "115", "116", "117", "118", "119", "120", "121", "122", "123",
  "124", "125", "126", "127", "128", "128", "129", "130", "131", "132", "133", "134", "135",
  "136", "137", "138", "139", "140", "141", "142", "143", "144", "145", "146", "147", "148",
  "149", "150",
]);
const DOC_ID_MAX = 128;

const isNonEmptyString = (v) => typeof v === "string" && v !== "";
const validDocId = (v) => isNonEmptyString(v) && v.length <= DOC_ID_MAX && !v.includes("/") && v !== "." && v !== "..";

// ── ตัวตัดสินแบบ pure (ใช้ร่วม middleware และ profile.loading) ────────────────────────────

/** isShopchampAdmin(adminConfig, uid) — uid อยู่ใน admin/adminConfig.admin (array ของ string) · อย่างอื่น = false */
function isShopchampAdmin(adminConfig, uid) {
  if (!isNonEmptyString(uid)) return false;
  if (!adminConfig || typeof adminConfig !== "object" || !Array.isArray(adminConfig.admin)) return false;
  return adminConfig.admin.some((a) => a === uid);
}

/** roleOf(person) — position มี '001' = owner · อย่างอื่น = staff (LoadingScreen.js:83) */
function roleOf(person) {
  const pos = person && Array.isArray(person.position) ? person.position : [];
  return pos.includes(OWNER_POSITION) ? "owner" : "staff";
}

/**
 * memberStatusOf(shop, uid, now) — สถานะผู้เรียกใน humanResource ตามกติกาแอปเก่า
 * @returns {{status:'active', person, index}} | {{status:'inactive', person, index}} | {{status:'not_a_member'}}
 *   index 0 = ใช้ status ของตัวเอง · index อื่น = status ของตัวเองเมื่อแพ็กเกจ staff ยังไม่หมด ไม่งั้น inActive
 *   มีหลายแถว id เดียวกัน: แถวที่ active แถวแรกชนะ (`find` ของแอปเก่า)
 */
function memberStatusOf(shop, uid, now) {
  const hr = shop && Array.isArray(shop.humanResource) ? shop.humanResource : [];
  if (!isNonEmptyString(uid)) return { status: "not_a_member" };
  const staffOk = isStaffPackageActive(shop, now);
  let firstMatch = null;
  for (let i = 0; i < hr.length; i++) {
    const p = hr[i];
    if (!p || typeof p !== "object" || p.id !== uid) continue;
    if (!firstMatch) firstMatch = { person: p, index: i };
    const effective = i === 0 || staffOk ? p.status : "inActive";
    if (effective === "active") return { status: "active", person: p, index: i };
  }
  return firstMatch ? { status: "inactive", person: firstMatch.person, index: firstMatch.index } : { status: "not_a_member" };
}

/**
 * resolveShopAccess({shopDocId, shop, uid, now, adminConfig}) — ตัดสิน ②③④ ของ requireShopAccess
 *   adminConfig: data ของ admin/adminConfig หรือฟังก์ชัน async ที่คืน data (อ่านเฉพาะเมื่อไม่ผ่าน ②)
 * @returns {Promise<{ok:true, access}> | {ok:false, status:403, error:'not_shop_member', extra:{reason}}>}
 */
async function resolveShopAccess({ shopDocId, shop, uid, now, adminConfig } = {}) {
  const m = memberStatusOf(shop, uid, now);
  if (m.status === "active") {
    const role = roleOf(m.person);
    const rights = role === "staff" && Array.isArray(m.person.rights) ? m.person.rights.filter((r) => typeof r === "string") : [];
    return { ok: true, access: { shopId: shopDocId, uid, role, rights } };
  }
  const cfg = typeof adminConfig === "function" ? await adminConfig() : adminConfig;
  if (isShopchampAdmin(cfg, uid)) {
    return { ok: true, access: { shopId: shopDocId, uid, role: "owner", rights: [], byAdmin: true } };
  }
  return deny(403, "not_shop_member", undefined, { reason: m.status });
}

// ── ด่านในตัว handler ─────────────────────────────────────────────────────────────

/**
 * callerAccess(req, bodyShopId) — handler เรียกก่อนแตะฐาน
 * @returns {{ok:true, access}} | deny 401 no_shop_access | deny 403 wrong_shop
 */
function callerAccess(req, bodyShopId) {
  const a = req && req.shopAccess;
  if (!a || typeof a !== "object" || !isNonEmptyString(a.shopId) || !isNonEmptyString(a.uid) || (a.role !== "owner" && a.role !== "staff")) {
    return deny(401, "no_shop_access");
  }
  if (bodyShopId !== a.shopId) return deny(403, "wrong_shop");
  return { ok: true, access: a };
}

/** isOwner(access) — เจ้าของ หรือทีมงาน (byAdmin ได้ role owner) */
function isOwner(access) {
  return !!access && access.role === "owner";
}

/** hasRight(access, code) — เจ้าของ/ทีมงาน ผ่านทุกสิทธิ์ · พนักงาน = rights มี code (เช่น '116' ยกเลิกบิล · '143' แก้ไขบิล) */
function hasRight(access, code) {
  if (!access) return false;
  if (access.role === "owner") return true;
  return Array.isArray(access.rights) && access.rights.some((r) => String(r) === String(code));
}

/** adminTrail(access) — field ที่เพิ่มบนทุกเอกสารที่ทีมงานเขียน · คนทั่วไป = {} */
function adminTrail(access) {
  return access && access.byAdmin === true ? { byAdmin: true, adminUid: access.uid } : {};
}

/** adminFlag(access) — field ในคำตอบ 2xx เมื่อทีมงานทำ · คนทั่วไป = {} */
function adminFlag(access) {
  return access && access.byAdmin === true ? { byAdmin: true } : {};
}

/** shopRefOf(shopDocId, shopData) — {id: doc id, shopId: field shop.shopId} (ร้านเก่า 2 ค่านี้ต่างกันได้ · schema/shop.md S5) */
function shopRefOf(shopDocId, shopData) {
  return { id: shopDocId, shopId: shopData && isNonEmptyString(shopData.shopId) ? shopData.shopId : null };
}

/**
 * belongsToShop(docShopId, shopRef) — เอกสาร (bill shift member paidHistory …) เป็นของร้านนี้ไหม
 *   ตรง doc id หรือตรง field shop.shopId (แอปเก่าเขียน member/paidHistory ด้วย field) · ว่าง/ไม่มี = ไม่ใช่ (fail-closed)
 */
function belongsToShop(docShopId, shopRef) {
  if (!isNonEmptyString(docShopId) || !shopRef) return false;
  return docShopId === shopRef.id || (isNonEmptyString(shopRef.shopId) && docShopId === shopRef.shopId);
}

/**
 * checkOwnedDoc(name, data, shopRef) — ไม่มี = deny 404 `<name>_not_found` · ร้านอื่น = deny 409 `<name>_other_shop` · ผ่าน = {ok:true}
 *   data = snap.exists ? snap.data() : undefined
 */
function checkOwnedDoc(name, data, shopRef) {
  if (data === undefined || data === null) return deny(404, `${name}_not_found`);
  if (!belongsToShop(data.shopId, shopRef)) return deny(409, `${name}_other_shop`);
  return { ok: true };
}

/** staffInShop(shop, staffId, access) — staffId อยู่ใน humanResource · ทีมงานใช้ uid ตัวเองได้แม้ไม่อยู่ (สัญญาข้อ 3-2) */
function staffInShop(shop, staffId, access) {
  if (!isNonEmptyString(staffId)) return false;
  if (access && access.byAdmin === true && staffId === access.uid) return true;
  const hr = shop && Array.isArray(shop.humanResource) ? shop.humanResource : [];
  return hr.some((p) => p && typeof p === "object" && p.id === staffId);
}

// ── middleware ─────────────────────────────────────────────────────────────────

// โหลด SDK ตอนเรียกจริงเท่านั้น (โหลดไฟล์นี้ใน harness/เทส = ไม่แตะ firebase-admin)
const realFirebase = () => require("../../firebase");

function bearerOf(req) {
  const h = req && req.headers ? req.headers.authorization || req.headers.Authorization : undefined;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

/**
 * makeCheckIfAuthenticated({verifyIdToken, log}) → middleware
 *   verifyIdToken(token, checkRevoked) ไม่ส่ง = admin.auth().verifyIdToken ตัวจริง · log ไม่ส่ง = console.warn
 *   ❌ ไม่ log token · log แค่รหัสเหตุ
 */
function makeCheckIfAuthenticated({ verifyIdToken, log } = {}) {
  const verify = verifyIdToken || ((t, c) => realFirebase().admin.auth().verifyIdToken(t, c));
  const warn = typeof log === "function" ? log : console.warn;
  return async function checkIfAuthenticated(req, res, next) {
    const token = bearerOf(req);
    if (!token) return fail(res, 401, "no_auth");
    let decoded;
    try {
      decoded = await verify(token, true);
    } catch (e) {
      try { warn("pos auth reject", (e && e.code) || "verify_failed"); } catch (_) { /* log ล้มไม่ล้มคำตอบ */ }
      return fail(res, 401, "no_auth");
    }
    const uid = decoded && decoded.uid;
    if (!isNonEmptyString(uid)) return fail(res, 401, "no_auth");
    const email = decoded && typeof decoded.email === "string" ? decoded.email.trim().toLowerCase() : null;
    req.auth = { uid, email };
    return next();
  };
}

/**
 * makeRequireShopAccess({db, now, log}) → middleware (ต่อหลัง checkIfAuthenticated)
 *   db ไม่ส่ง = functions/firebase ตัวจริง · now = deps.now (ไม่ส่ง = new Date()) ใช้ตัดสินแพ็กเกจ staff
 */
function makeRequireShopAccess({ db, now, log } = {}) {
  const getDb = () => db || realFirebase().db;
  const warn = typeof log === "function" ? log : console.warn;
  return async function requireShopAccess(req, res, next) {
    const shopId = req && req.body && typeof req.body === "object" ? req.body.shopId : undefined;
    if (!validDocId(shopId)) return fail(res, 400, "missing_shop_id");
    const uid = req.auth && req.auth.uid;
    if (!isNonEmptyString(uid)) return fail(res, 401, "no_auth");
    let verdict;
    try {
      const d = getDb();
      const snap = await d.collection("shop").doc(shopId).get();
      if (!snap.exists) return fail(res, 404, "shop_not_found");
      const at = await readNow({ now });
      verdict = await resolveShopAccess({
        shopDocId: shopId,
        shop: snap.data() || {},
        uid,
        now: at,
        adminConfig: async () => {
          const c = await d.collection("admin").doc("adminConfig").get();
          return c.exists ? c.data() : null;
        },
      });
    } catch (e) {
      try { warn("pos shopAccess error", e && e.message); } catch (_) { /* ไม่ล้มคำตอบ */ }
      return fail(res, 500, "internal_error");
    }
    if (!verdict.ok) {
      try { warn("pos shopAccess deny", shopId, verdict.extra && verdict.extra.reason); } catch (_) { /* ไม่ล้มคำตอบ */ }
      return sendDeny(res, verdict);
    }
    req.shopAccess = verdict.access;
    return next();
  };
}

const checkIfAuthenticated = makeCheckIfAuthenticated();
const requireShopAccess = makeRequireShopAccess();

module.exports = {
  checkIfAuthenticated,
  requireShopAccess,
  makeCheckIfAuthenticated,
  makeRequireShopAccess,
  isShopchampAdmin,
  roleOf,
  memberStatusOf,
  resolveShopAccess,
  callerAccess,
  isOwner,
  hasRight,
  adminTrail,
  adminFlag,
  shopRefOf,
  belongsToShop,
  checkOwnedDoc,
  staffInShop,
  INITIAL_RIGHTS,
  OWNER_POSITION,
};
