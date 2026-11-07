// pos/_shared/auth.js — ด่านตัวตนและด่านร้านของทุก route ใน pos (ก้อน 4 · DEV-0001)
//
// ยกท่าจากพี่น้อง (`middlewares/auth_middleware.js` verifyIdToken(token,true) · `claude/_shared/shopAccess.js` แกน requireShopAccess)
//   กติกาเข้าร้านใช้ของแอปเก่าบ้านนี้ (`shopchamp_app` src/screens/LoadingScreen.js:62-90 · WelcomeScreen.js:116-145)
//   ทีมงาน = ทะเบียน `watcher/roster` (_shared/watcherRoster.js · DEV-0001 watcher · Pack เคาะ 2026-11-07) · ❌ ไม่อ่าน admin/adminConfig แล้ว
//   ❌ ใช้ functions/middlewares/auth_middleware.js ไม่ได้ (แช่แข็ง + require env.json)
//
// middleware (route ต่อ 2 ตัวนี้ตามลำดับ · harness ไม่รัน middleware ⇒ เทสอยู่ที่ auth.test.js):
//   checkIfAuthenticated(req,res,next)
//     Authorization: Bearer <idToken> → verifyIdToken(token, true) (ตรวจการเพิกถอนด้วย)
//     ไม่มี/ไม่ผ่าน → 401 {ok:false, error:"no_auth"} · ผ่าน → req.auth = {uid, email}
//   requireShopAccess(req,res,next)   ร้านเป้าหมาย = body.shopId = shop **doc id**
//     body.shopId ไม่มี/รูปผิด → 400 missing_shop_id · ไม่มี req.auth → 401 no_auth
//     ① shop/{shopId} ไม่มี → 404 shop_not_found
//     ② uid อยู่ใน watcher/roster.rootUids (root · ≤10 คน · มาก่อนสมาชิกเหมือนทีมงานของแอปเก่า)
//        → req.shopAccess = {shopId, uid, role:'owner', rights:[], byAdmin:true, root:true}
//        ทะเบียนไม่มี/ว่าง/ผิดรูป = ไม่มีใครเป็นทีมงาน (fail-closed · watcherRoster.parseRoster)
//     ③ ผู้เรียกอยู่ใน shop.humanResource และ status 'active'
//        คนที่ไม่ใช่ index 0 นับ active ได้เมื่อแพ็กเกจ staff (แถวแรก) ยังไม่หมด ไม่งั้นถือเป็น inActive (กติกาแอปเก่า)
//        → req.shopAccess = {shopId, uid, role:'owner'|'staff', rights}   owner = position มี '001'
//          rights: staff = rights ของคนนั้น · owner = [] (เจ้าของผ่านทุกสิทธิ์ด้วย hasRight ไม่ต้องดู rights)
//     ③' ไม่ใช่สมาชิก active แต่อยู่ใน watcher/roster.uids (watcher) → อ่านได้อย่างเดียว
//        → req.shopAccess = {shopId, uid, role:'owner', rights:[], watcher:true, readOnly:true}
//        เส้นเขียนปัดที่ callerAccess 403 watcher_read_only (ด่านเดียวทุกเส้น · ค่าตั้งต้น = ปัด · เส้นอ่านต้องขอ {read:true} เอง)
//     ④ ไม่ผ่านทั้งหมด → 403 {ok:false, error:"not_shop_member", reason:'not_a_member'|'inactive'}
//
// ในตัว handler (ด่านซ้ำ เพราะ harness ส่ง req.shopAccess มาเอง):
//   callerAccess(req, body.shopId, {read}) → ไม่มี req.shopAccess = 401 no_shop_access · body.shopId ≠ ร้านที่ผ่านด่าน = 403 wrong_shop
//     · watcher (readOnly) บนเส้นที่ไม่ได้ส่ง {read:true} = 403 watcher_read_only
//   resolveShopRef({db, shopDocId, shop}) → shopRef (พิสูจน์ field ของร้าน S5 ก่อนเชื่อ)
//   checkOwnedDoc('bill', data, shopRef) → ไม่มี = 404 bill_not_found · ร้านอื่น = 409 bill_other_shop (ไม่คืนเนื้อ)
//   adminTrail(access) ใส่ทุกเอกสารที่เขียน · adminFlag(access) ใส่คำตอบ 2xx (root เท่านั้น · ชื่อ field byAdmin/adminUid คงเดิม ข้อ 5)
"use strict";

const { deny, sendDeny, fail } = require("./respond");
const { readNow } = require("./deps");
const { isStaffPackageActive } = require("./premium");
const WR = require("./watcherRoster");

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

/** rootAccess / watcherAccess — รูป access ของทีมงาน 2 ระดับ (ใช้ร่วม requireShopAccess · profile.loading · profile.manage · staff.checkIn) */
const rootAccess = (shopId, uid) => ({ shopId, uid, role: "owner", rights: [], byAdmin: true, root: true });
const watcherAccess = (shopId, uid) => ({ shopId, uid, role: "owner", rights: [], watcher: true, readOnly: true });

/** isStaffAccess(access) — ทีมงาน (root หรือ watcher) · ใช้ข้ามด่านสมาชิกซ้ำในตัว handler · ด่านเขียนอยู่ที่ callerAccess */
function isStaffAccess(access) {
  return !!access && (access.byAdmin === true || access.watcher === true);
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
 * resolveShopAccess({shopDocId, shop, uid, now, roster}) — ตัดสิน ②③③'④ ของ requireShopAccess
 *   roster: data ของ watcher/roster · ผลของ watcherRoster.parseRoster · หรือฟังก์ชัน async ที่คืนอย่างใดอย่างหนึ่ง (อ่านทุกคำขอ)
 *   ลำดับ:
 *     root (rootUids) → owner + byAdmin + root แม้เป็นพนักงานหรือ inActive ในร้านนั้น (ลำดับเดียวกับทีมงานของแอปเก่า
 *       `main3:src/screens/LoadingScreen.js:63,77,83` · Pack เคาะ 2026-11-07 ข้อ 2 แทน 3-2 ของ 2026-11-06)
 *     สมาชิก active → สิทธิ์ตามแถวของตัวเอง (watcher ที่เป็นพนักงานร้านนั้นจริง เขียนได้ในฐานะพนักงาน)
 *     watcher (uids) → owner + watcher + readOnly (อ่านได้ทุกอย่าง · เขียนไม่ได้)
 *     ไม่ใช่ทั้งหมด → 403 not_shop_member {reason}
 * @returns {Promise<{ok:true, access}> | {ok:false, status:403, error:'not_shop_member', extra:{reason}}>}
 */
async function resolveShopAccess({ shopDocId, shop, uid, now, roster } = {}) {
  const raw = typeof roster === "function" ? await roster() : roster;
  const role = WR.staffRoleOf(raw, uid);
  if (role === WR.ROLE.ROOT) return { ok: true, access: rootAccess(shopDocId, uid) };
  const m = memberStatusOf(shop, uid, now);
  if (m.status === "active") {
    const r = roleOf(m.person);
    const rights = r === "staff" && Array.isArray(m.person.rights) ? m.person.rights.filter((x) => typeof x === "string") : [];
    return { ok: true, access: { shopId: shopDocId, uid, role: r, rights } };
  }
  if (role === WR.ROLE.WATCHER) return { ok: true, access: watcherAccess(shopDocId, uid) };
  return deny(403, "not_shop_member", undefined, { reason: m.status });
}

// ── ด่านในตัว handler ─────────────────────────────────────────────────────────────

/**
 * callerAccess(req, bodyShopId, opts) — handler เรียกก่อนแตะฐาน
 *   opts.read === true = เส้น/op นี้อ่านอย่างเดียว ⇒ watcher ผ่าน · ไม่ส่ง = เส้นเขียน ⇒ watcher ถูกปัด (fail-closed:
 *   handler ใหม่ที่ลืมบอก = ปัด watcher ไม่ใช่ปล่อย · Pack เคาะ 2026-11-07 ข้อ 2)
 * @returns {{ok:true, access}} | deny 401 no_shop_access | deny 403 wrong_shop | deny 403 watcher_read_only
 */
function callerAccess(req, bodyShopId, opts) {
  const a = req && req.shopAccess;
  if (!a || typeof a !== "object" || !isNonEmptyString(a.shopId) || !isNonEmptyString(a.uid) || (a.role !== "owner" && a.role !== "staff")) {
    return deny(401, "no_shop_access");
  }
  if (bodyShopId !== a.shopId) return deny(403, "wrong_shop");
  if (isReadOnly(a) && !(opts && opts.read === true)) return deny(403, "watcher_read_only");
  return { ok: true, access: a };
}

/** isReadOnly(access) — watcher ที่ไม่ใช่สมาชิก (เขียนไม่ได้) · ช่อง readOnly หรือ watcher ตัวใดตัวหนึ่งก็นับ (fail-closed) */
function isReadOnly(access) {
  return !!access && (access.readOnly === true || access.watcher === true);
}

/** isOwner(access) — เจ้าของ หรือทีมงาน (root/watcher ได้ role owner · watcher ถูกปัดเขียนที่ callerAccess แล้ว) */
function isOwner(access) {
  return !!access && access.role === "owner";
}

/** hasRight(access, code) — เจ้าของ/ทีมงาน ผ่านทุกสิทธิ์ · พนักงาน = rights มี code (เช่น '116' ยกเลิกบิล · '143' แก้ไขบิล) */
function hasRight(access, code) {
  if (!access) return false;
  if (access.role === "owner") return true;
  return Array.isArray(access.rights) && access.rights.some((r) => String(r) === String(code));
}

/** adminTrail(access) — field ที่เพิ่มบนทุกเอกสารที่ root เขียน · คนทั่วไป = {} (ชื่อ byAdmin/adminUid คงเดิม · ข้อ 5) */
function adminTrail(access) {
  return access && access.byAdmin === true ? { byAdmin: true, adminUid: access.uid } : {};
}

/** adminFlag(access) — field ในคำตอบ 2xx เมื่อ root ทำ · คนทั่วไป = {} */
function adminFlag(access) {
  return access && access.byAdmin === true ? { byAdmin: true } : {};
}

/** fieldStateOf(shopData) — สภาพ field shop.shopId: 'present' (string ไม่ว่าง) · 'missing' (ไม่มี) · 'null' · 'invalid' (อย่างอื่น) */
function fieldStateOf(shopData) {
  const raw = shopData && typeof shopData === "object" ? shopData.shopId : undefined;
  if (raw === undefined) return "missing";
  if (raw === null) return "null";
  return isNonEmptyString(raw) ? "present" : "invalid";
}

/**
 * shopRefOf(shopDocId, shopData) — ตัวอ้างร้านแบบไม่อ่านฐาน · **ไม่เชื่อ field ที่ต่างจาก doc id** (fail-closed)
 *   {id: doc id, shopId: field เมื่อ field === doc id ไม่งั้น null, fieldState}
 *   ร้านเก่าที่ doc id ≠ field (ร้าน S5) ต้องใช้ resolveShopRef ซึ่งพิสูจน์ field ก่อน
 */
function shopRefOf(shopDocId, shopData) {
  const fieldState = fieldStateOf(shopData);
  const field = fieldState === "present" ? shopData.shopId : null;
  return { id: shopDocId, shopId: field !== null && field === shopDocId ? field : null, fieldState };
}

/**
 * resolveShopRef({db, shopDocId, shop}) — ตัวอ้างร้านที่ทุก route ใช้ · async (อ่านฐานเฉพาะร้าน S5)
 *   ร้าน S5 = doc id ≠ field shop.shopId (วัด 2026-11-06 สุ่ม 2,000 จาก 57,360 ร้าน: 19% · field เป็น uid เจ้าของ 28 ตัว)
 *     แอปเก่าเขียน bill/shift/member/paidHistory .shopId = field (`main3:src/screens/CheckoutScreen.js:113,757`)
 *   field มาจาก doc ร้านที่เจ้าของแก้เองได้ (rules เปิด) ⇒ เชื่อ field ได้เมื่อพิสูจน์ว่าค่านั้นผูกกับร้านนี้ร้านเดียว:
 *     ① ไม่มี doc shop/{field} (ค่าไม่ใช่ doc id ของร้านอื่น · กันตั้ง field = doc id ร้านเหยื่อ)
 *     ② shop where shopId == field ได้ 1 doc พอดีและเป็นร้านนี้ (กันตั้ง field ซ้ำกับร้าน S5 อื่น)
 *   ไม่ผ่าน = shopId:null ⇒ เอกสารที่ถือค่า field ถือเป็นร้านอื่น (409) · เจ้าของ S5 ที่ field ชนร้านอื่นเห็นแค่ของที่ถือ doc id
 *   อ่านพลาด = โยนต่อ (handler ตอบ 500 · ไม่เดาว่าเป็นของร้าน)
 *   อ่านนอก transaction (db ตรง) ⇒ ไม่เพิ่มล็อกใน transaction ของ handler · ไม่ขัดกฎอ่านก่อนเขียน
 * @returns {Promise<{id, shopId: string|null, fieldState, fieldVerified?: true}>}
 */
async function resolveShopRef({ db, shopDocId, shop } = {}) {
  const base = shopRefOf(shopDocId, shop);
  if (base.fieldState !== "present" || base.shopId !== null) return base;
  const field = shop.shopId;
  if (!validDocId(field)) return base;
  const shops = db.collection("shop");
  const [sameIdSnap, holders] = await Promise.all([
    shops.doc(field).get(),
    shops.where("shopId", "==", field).limit(2).get(),
  ]);
  if (sameIdSnap.exists) return base;
  const docs = holders && Array.isArray(holders.docs) ? holders.docs : [];
  if (docs.length !== 1 || docs[0].id !== shopDocId) return base;
  return { ...base, shopId: field, fieldVerified: true };
}

/**
 * belongsToShop(docShopId, shopRef) — เอกสาร (bill shift member paidHistory …) เป็นของร้านนี้ไหม
 *   ตรง doc id · หรือตรง shopRef.shopId (มีค่าเมื่อ field = doc id หรือ resolveShopRef พิสูจน์แล้ว) · ว่าง/ไม่มี = ไม่ใช่ (fail-closed)
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

/**
 * staffStatusOf(shop, staffId, access) — สถานะของ staffId ในร้าน: 'active' | 'inactive' | 'not_in_shop'
 *   root (byAdmin) ใช้ uid ตัวเองได้แม้ไม่อยู่ = 'active' · watcher ไม่ได้ (watcher ไม่มี byAdmin)
 *   แถวที่ id ตรงและ status 'active' แถวไหนก็ได้ = 'active' · มีแถวแต่ไม่ active สักแถว = 'inactive' (Pack เคาะ B-11 2026-11-06)
 *   ดู status ของแถวเท่านั้น (ไม่ดูแพ็กเกจ staff · คนเรียกผ่านด่านแพ็กเกจที่ requireShopAccess มาแล้ว)
 */
function staffStatusOf(shop, staffId, access) {
  if (!isNonEmptyString(staffId)) return "not_in_shop";
  if (access && access.byAdmin === true && staffId === access.uid) return "active";
  const hr = shop && Array.isArray(shop.humanResource) ? shop.humanResource : [];
  const rows = hr.filter((p) => p && typeof p === "object" && p.id === staffId);
  if (!rows.length) return "not_in_shop";
  return rows.some((p) => p.status === "active") ? "active" : "inactive";
}

/**
 * staffInShop(shop, staffId, access, opts) — staffId อยู่ใน humanResource · root ใช้ uid ตัวเองได้แม้ไม่อยู่
 *   opts.activeOnly = ต้อง status 'active' ด้วย (B-11 · ใช้ที่ shift.manage op open และ member.payCredit)
 *   route ที่ใช้: shift.manage (open: activeOnly · during/close: อยู่ในร้านพอ) · member.payCredit (activeOnly)
 */
function staffInShop(shop, staffId, access, opts) {
  const st = staffStatusOf(shop, staffId, access);
  if (st === "not_in_shop") return false;
  return opts && opts.activeOnly === true ? st === "active" : true;
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
    // อีเมลว่าง = null ไม่ใช่ '' (บทเรียนพี่น้อง watcherRoster.js:27-29 · ไม่มีใครตัดสินด้วยอีเมลแล้ว แต่กันคนรุ่นหลังเทียบ '')
    const rawEmail = decoded && typeof decoded.email === "string" ? decoded.email.trim().toLowerCase() : "";
    const email = rawEmail === "" ? null : rawEmail;
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
        roster: () => WR.readRoster(d),
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
  rootAccess,
  watcherAccess,
  isStaffAccess,
  isReadOnly,
  roleOf,
  memberStatusOf,
  resolveShopAccess,
  callerAccess,
  isOwner,
  hasRight,
  adminTrail,
  adminFlag,
  shopRefOf,
  resolveShopRef,
  fieldStateOf,
  belongsToShop,
  checkOwnedDoc,
  staffInShop,
  staffStatusOf,
  INITIAL_RIGHTS,
  OWNER_POSITION,
};
