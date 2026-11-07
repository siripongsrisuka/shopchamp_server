// pos/shopStaff/profileManage — บัญชีของผู้เรียกเอง: สร้าง แก้ เข้าร้าน ออกจากร้าน เอาร้านออกจากรายการ (ก้อน 9c · DEV-0001)
//
// สัญญา: shopchamp-center/api/profile.manage.yaml · คำขอ ProfileManageRequest (@shopchamp/schema › requests/shopStaff.ts)
// auth (route): checkIfAuthenticated อย่างเดียว (แบบ profile.loading) · ตัวตน = req.auth.uid · แก้ได้แค่ profile/{uid} ของตัวเอง
// แทน: `app:context/AuthContext.js:132-135` (สร้าง) · `app:screens/ProfileScreen.js:63-67` · `app:screens/WallpaperScreen.js:63` (แก้ทั้ง doc จากสำเนาเก่า DI-14)
//   `app:screens/WelcomeScreen.js:111-161` (เข้าร้าน: ตัดสินสิทธิ์ในเครื่อง แล้วเขียน port ทั้งก้อน) · `app:screens/HomeScreen.js:508` (ออกจากร้าน)
//   `app:Modal/Modal_Shop.js:38-50` (ลบร้านออกจากรายการทั้งก้อน · ลบ 2 ร้านติดกันร้านแรกกลับมา)
//
// ไม่มี req.auth.uid = 401 no_auth (route ส่ง 401 ก่อนแล้ว · ด่านซ้ำ)
//   create    : มี profile แล้ว = 200 created:false (ไม่ทับ) · ไม่มี = เขียนรูปเดียวกับ initialProfile + timestamp: now
//   update    : ไม่มี profile 404 profile_not_found · แก้เฉพาะช่องที่ส่ง
//   enterShop : tx อ่าน profile · shop/{shopId} · watcher/roster → ร้านไม่มี 404 shop_not_found
//               ตัดสินด้วย auth.resolveShopAccess ตัวเดียวกับ requireShopAccess (root ก่อน · สมาชิก active + แพ็กเกจพนักงาน · แล้ว watcher)
//               watcher เข้าร้านได้ (เขียนแค่ profile ของตัวเอง ไม่แตะข้อมูลร้าน) · คำตอบ access มี watcher/readOnly ⇒ จอซ่อนปุ่มเขียน
//               ไม่ผ่าน = 403 not_shop_member {reason} (พนักงาน inActive เข้าไม่ได้)
//               เขียน currentLogin {shopId: field shop.shopId, printer: ของแถว port เดิมหรือ [], rights: เจ้าของ/ทีมงาน = ชุดเต็ม · พนักงาน = rights ของตัวเอง}
//               และ port: แถวร้านนี้ย้ายขึ้นหน้า {...แถวเดิม, shopId, shopName, logo} (รูปเดิม WelcomeScreen.js:122-129)
//   leaveShop : currentLogin = {shopId:'', rights:[], printer:[]} (initialCurrentLogin)
//   removePort: เอาแถว port ที่ shopId ตรงออก (อ่านในฐานตอนนั้น ไม่ใช่สำเนาในเครื่อง) · ไม่มีแถว = 200 removed:false
"use strict";

const { db } = require("../../firebase");
const { ProfileManageRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError, deny } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { resolveShopAccess, INITIAL_RIGHTS } = require("../_shared/auth");
const WR = require("../_shared/watcherRoster");
const { isObj, Refusal, refuse } = require("./common");

const EMPTY_LOGIN = Object.freeze({ shopId: "", rights: [], printer: [] });

function logoOf(shop) {
  if (typeof shop.logo === "string" && shop.logo) return shop.logo;
  const img = Array.isArray(shop.imageUrl) ? shop.imageUrl.find((a) => isObj(a) && a.type === "logo") : null;
  return img && typeof img.value === "string" ? img.value : "";
}

function profileManage(deps) {
  return async function handler(req, res) {
    try {
      const uid = req && req.auth && typeof req.auth.uid === "string" && req.auth.uid ? req.auth.uid : null;
      if (!uid) return sendDeny(res, deny(401, "no_auth"));
      const body = isObj(req && req.body) ? req.body : {};
      const input = parseOr400(ProfileManageRequest, body, res);
      if (!input) return;

      const now = await readNow(deps);
      const profileRef = db.collection("profile").doc(uid);
      const shopRef = input.op === "enterShop" ? db.collection("shop").doc(input.shopId) : null;
      const cfgRef = input.op === "enterShop" ? WR.rosterRef(db) : null;

      const out = await db.runTransaction(async (tx) => {
        const [pSnap, shopSnap, cfgSnap] = await Promise.all([
          tx.get(profileRef),
          shopRef ? tx.get(shopRef) : Promise.resolve(null),
          cfgRef ? tx.get(cfgRef) : Promise.resolve(null),
        ]);
        const profile = pSnap.exists ? pSnap.data() || {} : null;

        if (input.op === "create") {
          if (profile) return { created: false };
          tx.set(profileRef, {
            imageId: "",
            timestamp: now,
            name: input.name,
            tel: input.tel,
            email: input.email,
            gender: "",
            birthday: "",
            port: [],
            currentLogin: { ...EMPTY_LOGIN, rights: [], printer: [] },
            wallPaper: { status: false, imageId: "" },
          });
          return { created: true };
        }
        if (!profile) refuse(deny(404, "profile_not_found", "ไม่พบบัญชีผู้ใช้"));
        const port = Array.isArray(profile.port) ? profile.port : [];

        if (input.op === "update") {
          const patch = {};
          for (const k of ["name", "tel", "email", "imageId", "wallPaper"]) if (input[k] !== undefined) patch[k] = input[k];
          tx.update(profileRef, patch);
          return { updated: Object.keys(patch) };
        }
        if (input.op === "leaveShop") {
          tx.update(profileRef, { currentLogin: { ...EMPTY_LOGIN, rights: [], printer: [] } });
          return {};
        }
        if (input.op === "removePort") {
          const left = port.filter((p) => !(isObj(p) && p.shopId === input.portShopId));
          if (left.length === port.length) return { removed: false };
          tx.update(profileRef, { port: left });
          return { removed: true };
        }

        // enterShop
        if (!shopSnap.exists) refuse(deny(404, "shop_not_found"));
        const shop = shopSnap.data() || {};
        const verdict = await resolveShopAccess({ shopDocId: input.shopId, shop, uid, now, roster: WR.snapToRoster(cfgSnap) });
        if (!verdict.ok) refuse(verdict);
        const access = verdict.access;
        const field = typeof shop.shopId === "string" && shop.shopId ? shop.shopId : input.shopId;
        const oldRow = port.find((p) => isObj(p) && p.shopId === field);
        const rights = access.role === "owner" ? [...INITIAL_RIGHTS] : access.rights;
        const currentLogin = { shopId: field, printer: oldRow && Array.isArray(oldRow.printer) ? oldRow.printer : [], rights };
        const row = { ...(oldRow || {}), shopId: field, shopName: typeof shop.name === "string" ? shop.name : "", logo: logoOf(shop) };
        tx.update(profileRef, { currentLogin, port: [row, ...port.filter((p) => !(isObj(p) && p.shopId === field))] });
        const a = { role: access.role, rights };
        if (access.byAdmin === true) { a.byAdmin = true; a.root = true; }
        if (access.watcher === true) { a.watcher = true; a.readOnly = true; }
        return { access: a, currentLogin };
      });

      return ok(res, { op: input.op, uid, ...out });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { profileManage };
