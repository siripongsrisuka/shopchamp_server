// pos/shopStaff/staffProfiles — ชื่อ/อีเมล/เบอร์/รูปของพนักงานในร้าน (DEV-0010 คลื่น 2 · อ่านอย่างเดียว)
//
// staff.profiles · POST /pos/staff/profiles: แทน `shopchamp_app/src/screens/StaffScreen.js:160-181`
//   ของเดิม: วน shop.humanResource แล้ว profile.doc(id).get() ทีละคนแบบรอคิว · มี doc = ใส่ {email, name, imageId, tel} · ไม่มี doc = ไม่อยู่ในรายการ
//   ใหม่:    อ่าน profile/{id} ของ id ที่อยู่ใน humanResource ของร้านนี้เท่านั้น (ไม่ซ้ำ · ขนานกัน) · ไม่รับรายชื่อ id จาก body
//   คำตอบ {profiles:{[uid]:{email, name, imageId, tel}}} · คนที่ไม่มี doc profile = ไม่มี key ⇒ จอทิ้งแบบเดิม
//     (Pack 2026-11-14 ข้อ 12: แสดงคนและช่องเหมือนแอปตอนนี้ · ❌ ไม่ยกพฤติกรรมพี่น้องที่ให้คนไม่มี profile โผล่ · ❌ ไม่ตัดอีเมล/เบอร์)
//     ช่องที่ doc ไม่มี = ไม่มี key (จอเดิม destructure ได้ undefined เท่ากัน)
//   สิทธิ์ '101' ตั้งค่า (เมนู `HomeScreen.js:78` → `ShopSettingScreen.js:23` จัดการพนักงาน) → ไม่มี 403 right_required
// ด่าน: middleware requireShopAccess (สมาชิกร้าน active / ทีมงาน) → callerAccess อ่านอย่างเดียว (watcher ผ่าน · ได้ทุกสิทธิ์แบบเจ้าของ)
// ค่าอ่าน: shop 1 + จำนวนพนักงาน (เดิม = จำนวนพนักงาน) · ไม่เขียน · แอปเก่าไม่เห็นอะไรเปลี่ยน
// ❌ ไม่ require SDK ตัวจริง · ใช้ ../../firebase เท่านั้น
"use strict";

const { db } = require("../../firebase");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { callerAccess, hasRight, adminFlag } = require("../_shared/auth");

const SETTINGS_RIGHT = "101";
const PROFILE_FIELDS = Object.freeze(["email", "name", "imageId", "tel"]);
const DOC_ID_MAX = 128;
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const validDocId = (v) => typeof v === "string" && v !== "" && v.length <= DOC_ID_MAX && !v.includes("/") && v !== "." && v !== "..";

function schemaOf(name) {
  const s = require("@shopchamp/schema")[name];
  if (!s || typeof s.safeParse !== "function") throw new Error(`@shopchamp/schema ไม่มี ${name}`);
  return s;
}

function staffProfiles(_deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId, { read: true });
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(schemaOf("StaffProfilesRequest"), body, res);
      if (!input) return;
      if (!hasRight(access, SETTINGS_RIGHT)) return sendDeny(res, deny(403, "right_required"));
      const shopSnap = await db.collection("shop").doc(access.shopId).get();
      if (!shopSnap.exists) return sendDeny(res, deny(404, "shop_not_found"));
      const shop = shopSnap.data() || {};
      const hr = Array.isArray(shop.humanResource) ? shop.humanResource : [];
      // id ที่อ่านได้ = แถวพนักงานของร้านนี้ (ทุกสถานะ แบบจอเดิม) · id เพี้ยน (มี / ว่าง) ข้าม (จอเดิมอ่านแล้วพัง → ใส่แถวเปล่า)
      const ids = [...new Set(hr.filter(isObj).map((p) => p.id).filter(validDocId))];
      const snaps = await Promise.all(ids.map((id) => db.collection("profile").doc(id).get()));
      const profiles = {};
      ids.forEach((id, i) => {
        if (!snaps[i].exists) return;
        const d = snaps[i].data() || {};
        const out = {};
        for (const f of PROFILE_FIELDS) if (d[f] !== undefined) out[f] = d[f];
        profiles[id] = out;
      });
      return ok(res, { ...adminFlag(access), profiles });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { staffProfiles };
