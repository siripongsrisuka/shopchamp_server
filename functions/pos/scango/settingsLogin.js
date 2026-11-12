// pos/scango/settingsLogin.js — 2 เส้นที่เซิร์ฟเวอร์ ScanGo ใช้ตรวจเจ้าของร้าน ตอน login เว็บร้าน ScanGo ด้วยบัญชี Shopchamp (Pack เคาะ 2026-11-12)
//   auth 'partner' (กุญแจร่วม header x-scango-platform-key · _partnerAuth.js) เหมือน /scango/* อื่น
//
// POST /pos/scango/settings-login/account {idToken}  (scango.loginAccount)
//   idToken = Firebase ID token ของบัญชี Shopchamp (project shopcham-24b0b) ที่หน้าเว็บ ScanGo ได้มา แล้วเซิร์ฟเวอร์ ScanGo ส่งต่อ
//   ตรวจด้วย admin.auth().verifyIdToken(token, true) (ตรวจการเพิกถอนด้วย · ท่าเดียวกับ _shared/auth.js › makeCheckIfAuthenticated)
//   ❌ ไม่ log idToken · log แค่รหัสเหตุ
//   หาร้านของคนนี้: profile/{uid}.port[].shopId (= field shopId ของร้าน ไม่ใช่ doc id) → shop where shopId == ค่านั้น
//     (ท่าเดียวกับเว็บเจ้าของร้าน ShopListScreen.js backToShop และ profile/loading.js) · port เรียงแถวที่ position มี '001' ก่อน · อ่าน ≤50 ค่า
//   ยืนยันซ้ำจาก shop.humanResource ทุกร้าน (ไม่เชื่อ port อย่างเดียว): _shared/auth › memberStatusOf (active ตามกติกาแอปเก่า) + roleOf = owner
//   → 200 {personRef: uid, name, shops:[{externalId: shop doc id, name}] ≤50} · token ผิด/หมดอายุ/ถูกเพิกถอน 401 account_token_invalid
//     · ไม่เป็นเจ้าของร้านไหนเลย (รวมไม่มี profile) 403 owner_only · idToken ไม่ใช่ข้อความ/ว่าง/ยาวเกิน 4096 · ช่องเกิน 400 invalid_request
//   name = profile.name → ชื่อใน token (displayName) → ชื่อแถวเจ้าของในร้านแรก → ''
//
// POST /pos/scango/settings-login/owner-check {personRef, externalId}  (scango.loginOwnerCheck)
//   ScanGo ถามซ้ำทุกครั้งที่ใช้สิทธิ์ (คนถูกถอดจากเจ้าของภายหลัง = isOwner false) · ร้าน = shop/{externalId} (doc id)
//   → 200 {isOwner, name, shopName} · name = ชื่อแถวเจ้าของ (ไม่ใช่เจ้าของ = '' · ไม่บอกชื่อพนักงาน) · ร้านไม่มี 404 shop_not_found
//
// อ่านอย่างเดียว ไม่เขียนฐาน · ❌ ห้าม require SDK ตัวจริงตรงนี้ (verifyIdToken ตัวจริงโหลดตอนเรียกเท่านั้น · harness/เทสฉีด deps.verifyIdToken)
"use strict";

const { db } = require("../../firebase");
const { ok } = require("../_shared/respond");
const { readNow, depOr } = require("../_shared/deps");
const { memberStatusOf, roleOf, OWNER_POSITION } = require("../_shared/auth");
const C = require("./_core");

const TOKEN_MAX = 4096;
const PORT_SCAN_MAX = 50; // ค่า shopId จาก port ที่อ่านต่อคำขอ
const SHOPS_MAX = 50; // ร้านที่คืน
const DOCS_PER_FIELD = 5; // doc ต่อค่า shopId (ร้านเก่าบางร้าน field ซ้ำกันได้ · profile/loading ใช้ตัวสุดท้าย)

const realVerify = (t, c) => require("../../firebase").admin.auth().verifyIdToken(t, c);
const textOf = (v) => (typeof v === "string" ? v.trim() : "");

/** ownerOf(shop, uid, now) → แถวเจ้าของที่ active · ไม่ใช่ = null (ตัวตัดสินเดียวกับ requireShopAccess) */
function ownerOf(shop, uid, now) {
  const m = memberStatusOf(shop, uid, now);
  return m.status === "active" && roleOf(m.person) === "owner" ? m.person : null;
}

/** portShopIds(profile) → ค่า field shopId จาก port (ไม่ซ้ำ · แถวที่ position มี '001' ก่อน · ≤PORT_SCAN_MAX) */
function portShopIds(profile) {
  const port = profile && Array.isArray(profile.port) ? profile.port : [];
  const rows = port.filter((p) => C.isObj(p) && typeof p.shopId === "string" && p.shopId !== "" && !p.shopId.includes("/"));
  const isOwnerRow = (p) => Array.isArray(p.position) && p.position.includes(OWNER_POSITION);
  const ordered = [...rows.filter(isOwnerRow), ...rows.filter((p) => !isOwnerRow(p))];
  return [...new Set(ordered.map((p) => p.shopId))].slice(0, PORT_SCAN_MAX);
}

function loginAccount(deps) {
  const verify = depOr(deps, "verifyIdToken", realVerify);
  const log = (deps && deps.log) || console; // รูปเดียวกับ _outbound.logOf ({info,warn,error})
  return C.wrap(async (req, res) => {
    const b = C.bodyOf(req);
    C.onlyKeys(b, ["idToken"]);
    if (typeof b.idToken !== "string" || b.idToken === "" || b.idToken.length > TOKEN_MAX) C.bad(`idToken ต้องเป็นข้อความยาว 1-${TOKEN_MAX} ตัว`);

    let decoded;
    try {
      decoded = await verify(b.idToken, true);
    } catch (e) {
      try { log.warn("pos/scango/settingsLogin reject", (e && e.code) || "verify_failed"); } catch (_) { /* log ล้มไม่ล้มคำตอบ */ }
      decoded = null;
    }
    const uid = decoded && typeof decoded.uid === "string" ? decoded.uid : "";
    if (!uid) C.refuse(401, "account_token_invalid", "บัญชี Shopchamp ไม่ถูกต้องหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่");

    const now = await readNow(deps);
    const pSnap = await db.collection("profile").doc(uid).get();
    const profile = pSnap.exists ? pSnap.data() || {} : {};

    const fields = portShopIds(profile);
    const results = await Promise.all(fields.map((f) => db.collection("shop").where("shopId", "==", f).limit(DOCS_PER_FIELD).get()));
    const seen = new Set();
    const shops = [];
    let ownerName = "";
    for (const snap of results) {
      for (const d of snap.docs) {
        if (seen.has(d.id) || shops.length >= SHOPS_MAX) continue;
        seen.add(d.id);
        const person = ownerOf(d.data() || {}, uid, now);
        if (!person) continue;
        if (!ownerName) ownerName = textOf(person.name);
        shops.push({ externalId: d.id, name: textOf((d.data() || {}).name) });
      }
    }
    if (!shops.length) C.refuse(403, "owner_only", "บัญชีนี้ไม่ได้เป็นเจ้าของร้านใน Shopchamp");

    const name = textOf(profile.name) || textOf(decoded.name) || ownerName;
    return ok(res, { personRef: uid, name, shops });
  });
}

function loginOwnerCheck(deps) {
  return C.wrap(async (req, res) => {
    const b = C.bodyOf(req);
    C.onlyKeys(b, ["personRef", "externalId"]);
    const uid = C.idOf(b.personRef, "personRef");
    const shopId = C.idOf(b.externalId, "externalId");
    const now = await readNow(deps);
    const shop = await C.loadShop(shopId);
    const person = ownerOf(shop, uid, now);
    return ok(res, { isOwner: !!person, name: person ? textOf(person.name) : "", shopName: textOf(shop.name) });
  });
}

module.exports = { loginAccount, loginOwnerCheck, portShopIds, ownerOf, TOKEN_MAX, PORT_SCAN_MAX, SHOPS_MAX };
