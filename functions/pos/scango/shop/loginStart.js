// pos/scango/shop/loginStart — เจ้าของขอรหัสเข้าเว็บร้าน ScanGo จากแอปร้าน (สัญญา scango.loginStart · auth 'shop')
//
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง origin/main `functions/claude/scango/settingsLogin.js` › start
//   แอปเปิด WebView `https://merchant.scango.biz/?in=pos#pc=<code>` → เว็บส่ง code ให้เซิร์ฟเวอร์ ScanGo
//   (scango_server `functions/auth/posExchange.js`) → connector.redeemLoginCode → `POST /pos/scango/settings-login/redeem` (scango.loginRedeem)
// คำขอ {shopId} · คำตอบ 200 {ok, code:'<id20>.<hex64>', expiresAt:<ms>} · อายุ 2 นาที · ใช้ครั้งเดียว
// ด่าน: callerAccess (เขียน · watcher 403 watcher_read_only) → schema 400
//   → ร้านไม่มี 404 shop_not_found → ไม่ใช่แถวเจ้าของ active ใน humanResource 403 owner_only
//   (`../settingsLogin`.ownerOf · ทีมงาน Shopchamp ที่ไม่ได้เป็นเจ้าของร้าน = 403 ตามต้นแบบ: root ไม่ได้ · สัญญา R1)
// เขียน: `create()` doc `scangoSettingsLogin/{id20}` = {secretHash, shopId, personId: uid, status:'pending', createdAt, expiresAt} (รูปเดียวกับต้นแบบ · ไม่ผนึก · B2)
//   (ไม่ใช่ set · id ชน = ลองใหม่ 1 ครั้งแล้วยอมเป็น 500 · ท่าเดียวกับ webLogin.start) · ❌ ไม่เก็บ secret ดิบ (`../_loginCode`)
// deps: now · newCode() → {id, secret} (harness ตรึงค่า) · audit(line)
// ❌ ไม่ require SDK ตัวจริง
"use strict";

const { db } = require("../../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../../_shared/respond");
const { readNow, depOr } = require("../../_shared/deps");
const { callerAccess } = require("../../_shared/auth");
const { ownerOf } = require("../settingsLogin");
const L = require("../_loginCode");
const C = require("./_common");

const isExists = (e) => !!e && (e.code === 6 || e.code === "already-exists" || /ALREADY_EXISTS/.test(String(e.message)));

function loginStart(deps) {
  const audit = L.auditOf(deps);
  return async function handler(req, res) {
    let shopId = "", uid = "";
    try {
      const body = C.isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      shopId = access.shopId; uid = access.uid;
      const input = parseOr400(C.SettingsGetRequest, body, res);
      if (!input) return;
      const gen = depOr(deps, "newCode", L.newCode);
      const now = await readNow(deps);
      const snap = await db.collection("shop").doc(shopId).get();
      if (!snap.exists) return sendDeny(res, deny(404, "shop_not_found"));
      if (!ownerOf(snap.data() || {}, uid, now)) { audit("start", "owner_only", shopId, uid); return sendDeny(res, deny(403, "owner_only", L.MSG.owner_only)); }

      const expiresAt = new Date(now.getTime() + L.TTL_MS);
      let made = null;
      for (let attempt = 0; attempt < 2 && !made; attempt++) {
        const g = gen() || {};
        if (!L.SID_RE.test(String(g.id)) || !L.HEX64_RE.test(String(g.secret))) throw new Error("scango.loginStart: ตัวสุ่มรหัสคืนรูปผิด");
        const doc = {
          secretHash: L.sha256Hex(g.secret), // ❌ ไม่เก็บ secret ดิบ
          shopId,
          personId: uid,
          status: "pending",
          createdAt: now,
          expiresAt,
        };
        try {
          await db.collection(L.COLLECTION).doc(g.id).create(doc);
          made = g;
        } catch (e) {
          if (!isExists(e) || attempt === 1) throw e;
        }
      }
      audit("start", "ok", shopId, uid);
      return ok(res, { code: `${made.id}.${made.secret}`, expiresAt: expiresAt.getTime() });
    } catch (e) {
      audit("start", "internal_error", shopId, uid);
      return internalError(res, e);
    }
  };
}

module.exports = { loginStart };
