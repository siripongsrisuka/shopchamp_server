// pos/scango/settingsLogin.js — 3 เส้นที่เซิร์ฟเวอร์ ScanGo ใช้ตอนเข้าเว็บร้าน ScanGo: login ด้วยบัญชี Shopchamp (account · owner-check) และแลกรหัสจากแอปร้าน (redeem) · Pack เคาะ 2026-11-12
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
// POST /pos/scango/settings-login/redeem {code}  (scango.loginRedeem · รอบ 4 Pack เคาะ 2026-11-12)
//   แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/scango/settingsLogin.js` › redeem · ผู้เรียก = connector ฝั่ง ScanGo
//   (`redeemLoginCode` → `/auth/pos/exchange` ของ scango_server) · code = ที่ scango.loginStart ออก (`<id20>.<hex64>` · `_loginCode.js`)
//   ลำดับตรวจ (ต้นแบบ · ไม่มีผนึกแล้ว Pack เคาะ B2): รูป 400 code_invalid → ใน transaction:
//     ไม่มี doc 404 code_not_found · secret ผิด 404 code_not_found (ไม่บอกว่ามีรหัสนี้)
//     · หมดอายุ/expiresAt อ่านไม่ออก 410 code_expired · status ≠ pending 409 already_used · ใบไม่มี shopId/personId 409 already_used (ต้นแบบ)
//     · ร้านไม่มี / personId ไม่ใช่แถวเจ้าของ active ใน humanResource **ตอนแลก** 403 owner_only (ใบยัง pending · หมดอายุเองใน 2 นาที)
//     → update ใบ {status:'claimed', claimedAt} + ประทับ shop.scango.merchantLinkedAt ครั้งแรกครั้งเดียว (dotted ช่องเดียว · scango.loginStatus อ่าน)
//   → 200 {externalId: shop doc id, personRef: uid, name: ชื่อแถวเจ้าของ, venueName: ชื่อร้าน}
//   รหัสปฏิเสธ = ชุด LOGIN_CODES ที่ connector แปล (code_invalid 400 · code_not_found 404 · already_used 409 · code_expired 410 · owner_only 403)
//   ช่องเกิน = 400 invalid_request · log 1 บรรทัด/เหตุการณ์ ❌ ไม่มีรหัส
//
// account / owner-check อ่านอย่างเดียว ไม่เขียนฐาน · ❌ ห้าม require SDK ตัวจริงตรงนี้ (verifyIdToken ตัวจริงโหลดตอนเรียกเท่านั้น · harness/เทสฉีด deps.verifyIdToken)
"use strict";

const { db } = require("../../firebase");
const { ok } = require("../_shared/respond");
const { readNow, depOr } = require("../_shared/deps");
const { memberStatusOf, roleOf, OWNER_POSITION } = require("../_shared/auth");
const C = require("./_core");
const L = require("./_loginCode");

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

function loginRedeem(deps) {
  const audit = L.auditOf(deps);
  const no = (status, code) => C.refuse(status, code, L.MSG[code]);
  return C.wrap(async (req, res) => {
    const b = C.bodyOf(req);
    C.onlyKeys(b, ["code"]);
    const parsed = L.parseCode(b.code);
    if (!parsed) { audit("redeem", "code_invalid", "", ""); no(400, "code_invalid"); }
    const now = await readNow(deps);
    const ref = db.collection(L.COLLECTION).doc(parsed.id);
    let out;
    try {
      out = await C.runTx(async (tx) => {
        const snap = await tx.get(ref);
        const d = snap && snap.exists ? snap.data() || {} : null;
        if (!d) no(404, "code_not_found");
        if (!L.secretMatches(parsed.secret, d.secretHash)) no(404, "code_not_found");
        const expMs = L.msOf(d.expiresAt);
        if (expMs === null || L.isExpired(now.getTime(), expMs)) no(410, "code_expired"); // อ่านไม่ออก = หมดอายุ (fail-closed · ต้นแบบ)
        if (d.status !== "pending") no(409, "already_used");
        if (typeof d.shopId !== "string" || !C.ID_RE.test(d.shopId) || typeof d.personId !== "string" || !d.personId) no(409, "already_used");
        const shopRef = db.collection("shop").doc(d.shopId);
        const shopSnap = await tx.get(shopRef);
        const shop = shopSnap && shopSnap.exists ? shopSnap.data() || {} : null;
        const person = shop ? ownerOf(shop, d.personId, now) : null;
        if (!person) no(403, "owner_only");
        tx.update(ref, { status: "claimed", claimedAt: now });
        if (!(C.isObj(shop.scango) && shop.scango.merchantLinkedAt)) tx.update(shopRef, { "scango.merchantLinkedAt": now });
        return { externalId: d.shopId, personRef: d.personId, name: textOf(person.name), venueName: textOf(shop.name) };
      });
    } catch (e) {
      if (e instanceof C.Refusal) audit("redeem", e.deny.error, "", "");
      throw e;
    }
    audit("redeem", "ok", out.externalId, out.personRef);
    return ok(res, out);
  });
}

module.exports = { loginAccount, loginOwnerCheck, loginRedeem, portShopIds, ownerOf, TOKEN_MAX, PORT_SCAN_MAX, SHOPS_MAX };
