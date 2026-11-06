// pos/shopStaff/lineSettings — บันทึกการเชื่อมต่อ LINE OA ของร้าน · token เข้าที่ลับ + สำเนาเดิมให้แอปเก่า (ก้อน 10 รอบ 2c · DEV-0001 · LS-033)
//
// สัญญา: shopchamp-center/api/shop.lineSettings.yaml · คำขอ ShopLineSettingsRequest (@shopchamp/schema › requests/lineSettings.ts)
// แทน `app:screens/LineSettingScreen.js:97-104` (dispatch updateFieldShop {line: ค่าจากเครื่องทั้งก้อน} · ไม่ await · ขึ้น "สำเร็จ" ก่อนรู้ผล)
// decision 2026-11-06 ข้อ #12 #13 ทาง 2: แอปใหม่ใช้ที่ลับ · คงสำเนาเดิมไว้ให้แอปเก่า
//   ที่ลับ  `lineSecrets/{shop doc id}` = {channelAccessToken: กล่อง secretBox, updatedAt, updatedBy, byAdmin?, adminUid?}
//           กล่องผูก AAD providerId 'line' · field 'channelAccessToken' · shopId = doc id ร้าน (ย้ายข้ามร้านถอดไม่ออก)
//           rules ไม่มี match ⇒ client อ่าน/เขียนไม่ได้ (ค่าตั้งต้นของ firestore.rules)
//   สำเนาเดิม `shop.line` = {...ค่าเดิม, liff, userId, channelAccessToken} รูปเดิม
//           แอปเก่า (และจอแจ้งเตือนของแอปใหม่ตอนนี้) อ่าน token จาก doc ร้านแล้วส่งให้ `/line/*` เอง
//           (`functions/apis/line.js` รับ token จาก body ทุกเส้น ไม่อ่านจากฐาน) ⇒ ต้องเขียนสำเนาไม่งั้นแจ้งเตือนเดิมหยุด
//
// ลำดับ: callerAccess → schema → สิทธิ์ '101' ตั้งค่า (เมนูเดิม HomeScreen ตั้งค่า → AdvanceScreen:28 → LineManagerScreen → จอนี้)
//   → กุญแจเข้ารหัส (deps.credKey → env GATEWAY_CRED_ENC_KEY) ไม่มี/ผิดรูป = 503 {code} ไม่เขียนอะไร (fail-closed)
//   → tx: shop/{shopId} · lineSecrets/{shopId} · ร้านไม่มี 404 · ผู้เรียกไม่ active 403 not_shop_member
//   token ที่ใช้: คำขอ → สำเนาเดิม → ที่ลับถอดได้ · ไม่มีเลย 400 token_required
//     สำเนาเดิมมาก่อนที่ลับ: แอปเก่ายังเขียนสำเนาตรงได้ และตัวที่ส่งแจ้งเตือนจริงตอนนี้คือสำเนา ⇒ ที่ลับอาจเก่ากว่า (ไม่ย้อนสำเนากลับเป็นค่าเก่า)
//   ไม่มีอะไรเปลี่ยน (สำเนาเท่าเดิม และที่ลับถอดได้ token เดียวกัน) = 200 changed:false ไม่เขียน
//   เขียน: lineSecrets set (เมื่อ token ในที่ลับไม่ตรง/ไม่มี) · shop update {line, settingsUpdate} (เมื่อสำเนาเปลี่ยน)
// ❌ คำตอบไม่มี token (มีแค่ hasToken) · ❌ ไม่ log ค่าใด ๆ · ❌ ห้าม require SDK ตัวจริง ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { ShopLineSettingsRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, hasRight, adminFlag, adminTrail } = require("../_shared/auth");
const SB = require("../gateway/secretBox");
const { isObj, Refusal, refuse, callerStillActive, sameValue } = require("./common");

const SETTINGS_RIGHT = "101";
const SECRET_COLLECTION = "lineSecrets";
const BINDING = Object.freeze({ providerId: "line", field: "channelAccessToken" });

function lineSettings(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;

      const input = parseOr400(ShopLineSettingsRequest, body, res);
      if (!input) return;
      if (!hasRight(access, SETTINGS_RIGHT)) return sendDeny(res, deny(403, "right_required", undefined, { right: SETTINGS_RIGHT }));

      const k = SB.readKey({ deps, env: deps && isObj(deps.env) ? deps.env : undefined });
      if (k.error) return sendDeny(res, deny(503, "secret_key_missing", "ระบบยังไม่พร้อมเก็บ token (ยังไม่ได้ตั้งกุญแจเข้ารหัส)", { code: k.error.code }));

      const now = await readNow(deps);
      const shopRef = db.collection("shop").doc(input.shopId);
      const secretRef = db.collection(SECRET_COLLECTION).doc(input.shopId);
      const binding = { ...BINDING, shopId: input.shopId };

      const out = await db.runTransaction(async (tx) => {
        const [shopSnap, secretSnap] = await Promise.all([tx.get(shopRef), tx.get(secretRef)]);
        if (!shopSnap.exists) refuse(deny(404, "shop_not_found"));
        const shop = shopSnap.data() || {};
        const still = callerStillActive(shop, access, now);
        if (still) refuse(still);

        const oldLine = isObj(shop.line) ? shop.line : null;
        const secret = secretSnap && secretSnap.exists ? secretSnap.data() || {} : null;
        const opened = secret && SB.isBox(secret.channelAccessToken) ? SB.open(secret.channelAccessToken, binding, { key: k.key }) : null;
        const fromSecret = opened && typeof opened.plain === "string" && opened.plain ? opened.plain : null;
        const fromCopy = oldLine && typeof oldLine.channelAccessToken === "string" && oldLine.channelAccessToken ? oldLine.channelAccessToken : null;
        const token = input.channelAccessToken !== undefined ? input.channelAccessToken : fromCopy || fromSecret;
        if (!token) refuse(deny(400, "token_required", "กรุณาใส่ Channel access token"));

        const newLine = { ...(oldLine || {}), liff: input.liff, userId: input.userId, channelAccessToken: token };
        const fields = [];
        if (fromSecret !== token) {
          const sealed = SB.seal(token, binding, { key: k.key });
          if (sealed.error) refuse(deny(503, "secret_key_missing", undefined, { code: sealed.error.code }));
          tx.set(secretRef, { channelAccessToken: sealed.box, updatedAt: now, updatedBy: access.uid, ...adminTrail(access) });
          fields.push("secret");
        }
        if (!sameValue(oldLine, newLine)) {
          const trail = { at: now, by: access.uid, fields: ["line"], ...adminTrail(access) };
          tx.update(shopRef, { line: newLine, settingsUpdate: trail });
          fields.push("line");
        }
        return { changed: fields.length > 0, fields, line: { liff: newLine.liff, userId: newLine.userId, hasToken: true } };
      });

      return ok(res, { shopId: input.shopId, ...out, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { lineSettings, SECRET_COLLECTION, BINDING };
