// pos/notification/list — ประวัติแจ้งเตือนของร้าน 30 ใบล่าสุด (DEV-0010 คลื่น 2 · กลุ่ม shop/system)
//
// สัญญา: shopchamp-center/api/notification.list.yaml · route POST /pos/notification/list (auth shop · อ่านอย่างเดียว)
// แทน: `shopchamp_app/src/screens/NotificationHistory.js:93`
//   ของเดิม: notification where shopId == shop.shopId orderBy timestamp desc limit 30 · จอกรองหมวดเองในเครื่อง (:79 · คงเดิม)
// แบบที่ยึดจากพี่น้อง: server แอปพี่น้อง `functions/claude/notify/list.js:1-40` (auth shop · whitelist ช่อง)
//   ต่างจากต้นแบบ: ขั้นนี้คง limit 30 + เรียงเดิม (เท่าแอปเดิม) · ❌ ไม่ยกหน้าต่าง 7 วัน/กรองหมวดที่ server/cursor (ถาม Pack ก่อนถ้าจะยก)
// ช่องที่คืน (จอใช้ `NotificationHistory.js:41,79`): id · heading · notificationContent · categoryId · timestamp (ISO)
// ค่าค้น shopId = ช่อง shopId ของ doc ร้านที่ผู้เรียกผ่านด่านแล้ว · ไม่มี = doc id (Pack 2026-11-14 ข้อ 8 · แบบที่ server เขียน `company/_orders.js:153-154`)
// สิทธิ์ (Pack ข้อ 9 · เท่าที่แอปเปิดตอนนี้): ไทล์ 109 (`HomeScreen.js:97`) + พรีเมียม (`premiumPath` `HomeScreen.js:107,474`)
//   เจ้าของ/ทีมงานผ่านสิทธิ์ · พรีเมียมหมด = 403 premium_required ทุกคน (แอปเดิมปัดทุกคนรวมทีมงาน)
// Firestore อ่าน: shop/{shopId} · notification ≤ 30 doc (+1 ของ middleware) · index notification(shopId ASC, timestamp DESC) ใช้ตัวเดียวกับแอปเดิม
// ❌ ห้าม require SDK ตัวจริงตรงนี้ · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { ok, fail, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { callerAccess, adminFlag, hasRight } = require("../_shared/auth");
const { readNow } = require("../_shared/deps");
const { isPremiumActive } = require("../_shared/premium");
const { schemaOf } = require("../stock/_shared");
const { toPlain } = require("../profile/loading");
const { memberDeny } = require("../shop/_appView");

const LIMIT = 30;
const RIGHT = "109";
const FIELDS = Object.freeze(["heading", "notificationContent", "categoryId", "timestamp"]);

const shopKey = (shopDocId, shop) => (typeof shop.shopId === "string" && shop.shopId !== "" ? shop.shopId : shopDocId);

function rowOf(id, d) {
  const out = { id };
  for (const f of FIELDS) if (d[f] !== undefined) out[f] = toPlain(d[f]);
  return out;
}

function list(deps) {
  return async function handler(req, res) {
    try {
      const body = req && req.body && typeof req.body === "object" ? req.body : {};
      const gate = callerAccess(req, body.shopId, { read: true });
      if (!gate.ok && gate.status === 401) return sendDeny(res, gate);
      const input = parseOr400(schemaOf("NotificationListRequest"), body, res);
      if (!input) return res;
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      if (!hasRight(access, RIGHT)) return sendDeny(res, deny(403, "right_required"));

      const shopSnap = await db.collection("shop").doc(access.shopId).get();
      if (!shopSnap.exists) return fail(res, 404, "shop_not_found");
      const shop = shopSnap.data() || {};
      const denied = memberDeny(shop, access);
      if (denied) return sendDeny(res, denied);
      const now = await readNow(deps);
      if (!isPremiumActive(shop, now)) return fail(res, 403, "premium_required");

      const key = shopKey(access.shopId, shop);
      const snap = await db.collection("notification")
        .where("shopId", "==", key)
        .orderBy("timestamp", "desc")
        .limit(LIMIT)
        .select(...FIELDS, "shopId")
        .get();
      const rows = snap.docs
        .filter((d) => { const x = d.data(); return x && typeof x === "object" && x.shopId === key; })
        .map((d) => rowOf(d.id, d.data()));
      return ok(res, { ...adminFlag(access), rows });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { list, LIMIT, FIELDS };
