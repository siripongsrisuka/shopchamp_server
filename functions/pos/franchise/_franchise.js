// pos/franchise/_franchise.js — ด่านและของร่วมของเส้นเว็บแฟรนไชส์ (ก้อน 9f · DEV-0002)
//
// route ทุกตัว auth 'user' (checkIfAuthenticated อย่างเดียว · ไม่มีร้านใน body) ⇒ ตัดสินสิทธิ์ใน handler จาก doc แฟรนไชส์
// ลำดับด่าน (ทุกเส้น):
//   ไม่มี req.auth.uid 401 no_auth → body ผิด schema 400 invalid_request → franchise/{franchiseId} ไม่มี 404 franchise_not_found
//   → root (watcher/roster.rootUids · DEV-0001 watcher · Pack เคาะ 2026-11-07) ผ่านทุกแฟรนไชส์ สิทธิ์ครบ เขียนได้ (รอย byAdmin/adminUid)
//   → สมาชิก: uid ต้องอยู่ใน humanResource (ตัวเดียวกับที่ rules และรายการเดิมใช้ · fr:FranchiseListScreen.js:65)
//       ไม่อยู่ 403 not_franchise_member {reason:'not_a_member'}
//       แถว humanRight ของตัวเองมี status และไม่ใช่ 'active' 403 not_franchise_member {reason:'inactive'} (ข้อมูลเดิมไม่มี status ⇒ ผ่านทุกคน)
//       สิทธิ์ = humanRight[uid].rights (ไม่มีแถว = ไม่มีสิทธิ์) · เส้นที่ต้องการสิทธิ์ไม่มี 403 right_required
//   → ไม่ใช่สมาชิก แต่อยู่ใน watcher/roster.uids (watcher) = สิทธิ์ครบ อ่านอย่างเดียว · เส้นเขียน 403 watcher_read_only
//       เส้นอ่าน / ข้อยกเว้นเขียน = ตาราง MODE ข้างล่าง (ชื่อ schema ของคำขอ) · ไม่อยู่ในตาราง = เส้นเขียน (fail-closed)
//       ข้อยกเว้นเขียนเส้นเดียว: ผูกร้านเข้าแฟรนไชส์ (franchise.branchAttach) · ลง watcherWriteLog (Pack เคาะ ข้อ 4)
//   → เส้นทีมงานเท่านั้น (ค้น/ผูกสาขา · ปุ่มเดิมเห็นเฉพาะ initialAdmin fr:BranchScreen.js:93) ไม่ใช่ root/watcher 403 admin_required
// ทุกตัวในไฟล์นี้ pure ยกเว้น readGate (อ่านฐานผ่าน getter ที่ส่งมา ⇒ ใช้ได้ทั้งใน transaction และนอก)
"use strict";

const { db } = require("../../firebase");
const { deny, ok, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { AsyncLocalStorage } = require("async_hooks");
const WR = require("../_shared/watcherRoster");

// โหมดของแต่ละเส้น ตามชื่อ schema ของคำขอ · readGate อ่านผ่าน AsyncLocalStorage ที่ makeHandler ตั้งให้
//   ⇒ ไฟล์ handler ไม่ต้องบอกเอง และ handler ใหม่ที่ไม่อยู่ในตาราง = เส้นเขียน (watcher ถูกปัด)
const READ_SCHEMAS = Object.freeze(new Set([
  "FranchiseListRequest", "FranchiseGetRequest", "FranchiseWarehouseListRequest", "FranchiseLinkListRequest",
  "FranchiseBranchListRequest", "FranchiseBranchFindRequest", "FranchiseStaffFindRequest", "FranchiseBillListRequest",
]));
const WATCHER_WRITE_SCHEMAS = Object.freeze(new Set(["FranchiseBranchAttachRequest"]));
const MODE = new AsyncLocalStorage();
const modeOf = (schemaName) => ({ read: READ_SCHEMAS.has(schemaName), watcherWrite: WATCHER_WRITE_SCHEMAS.has(schemaName) });

const RIGHT = Object.freeze({ DASHBOARD: "100", BY_SHOP: "103", BY_ITEM: "104", OVERVIEW: "107", WAREHOUSE: "128", STAFF: "723", PROFILE: "130" });
const ALL_RIGHTS = Object.freeze(["100", "103", "104", "107", "128", "723", "130"]);

const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const str = (v) => (typeof v === "string" ? v : "");
const arr = (v) => (Array.isArray(v) ? v : []);

class Refusal extends Error {
  constructor(d) { super(d.error); this.deny = d; }
}
const refuse = (d) => { throw new Refusal(d); };

/** uidOf(req) — uid จาก checkIfAuthenticated · ไม่มี = null */
function uidOf(req) {
  const u = req && req.auth && req.auth.uid;
  return typeof u === "string" && u ? u : null;
}

/**
 * franchiseAccessOf({franchise, uid, roster}) — ตัดสินว่าผู้เรียกเข้าแฟรนไชส์นี้ได้แค่ไหน (pure)
 *   roster = data ของ watcher/roster หรือผลของ watcherRoster.parseRoster · ไม่มี/ว่าง = ไม่มีทีมงาน
 *   ลำดับ: root → สมาชิก → watcher (watcher ที่เป็นสมาชิกจริงได้สิทธิ์ตามแถวตัวเอง เขียนได้ในฐานะสมาชิก)
 * @returns {{ok:true, access:{uid, byAdmin:boolean, root?, watcher?, readOnly?, rights:string[]}} | deny 403 not_franchise_member {reason}}
 */
function franchiseAccessOf({ franchise, uid, roster } = {}) {
  const role = WR.staffRoleOf(roster, uid);
  if (role === WR.ROLE.ROOT) return { ok: true, access: { uid, byAdmin: true, root: true, rights: [...ALL_RIGHTS] } };
  const f = isObj(franchise) ? franchise : {};
  const member = memberAccessOf(f, uid);
  if (member.ok) return member;
  if (role === WR.ROLE.WATCHER) return { ok: true, access: { uid, byAdmin: false, watcher: true, readOnly: true, rights: [...ALL_RIGHTS] } };
  return member;
}

function memberAccessOf(f, uid) {
  if (!arr(f.humanResource).some((x) => x === uid)) return deny(403, "not_franchise_member", undefined, { reason: "not_a_member" });
  const row = arr(f.humanRight).find((r) => isObj(r) && r.id === uid);
  if (row && typeof row.status === "string" && row.status !== "active") return deny(403, "not_franchise_member", undefined, { reason: "inactive" });
  const rights = row ? arr(row.rights).filter((r) => typeof r === "string") : [];
  return { ok: true, access: { uid, byAdmin: false, rights } };
}

const isStaff = (access) => !!access && (access.byAdmin === true || access.watcher === true);

/**
 * needRight(access, {rights, adminOnly, read, watcherWrite}) → null | deny · rights = มีตัวใดตัวหนึ่งก็พอ
 *   adminOnly = เส้นทีมงาน (root หรือ watcher) · read = เส้นอ่าน · watcherWrite = ข้อยกเว้นเขียนของ watcher
 */
function needRight(access, { rights, adminOnly, read, watcherWrite } = {}) {
  if (adminOnly && !isStaff(access)) return deny(403, "admin_required", "เฉพาะทีมงาน Shopchamp");
  if (access && access.readOnly === true && read !== true && watcherWrite !== true) return deny(403, "watcher_read_only");
  const need = Array.isArray(rights) ? rights : [];
  if (!need.length || isStaff(access)) return null;
  return need.some((r) => access && access.rights.includes(r)) ? null : deny(403, "right_required");
}

/**
 * readGate(getter, franchiseId, uid, opts) — อ่าน franchise + watcher/roster แล้วผ่านด่าน · ไม่ผ่าน = throw Refusal
 *   getter(ref) = (ref) => ref.get() นอก transaction · (ref) => tx.get(ref) ใน transaction
 *   โหมดอ่าน/ข้อยกเว้นเขียน มาจาก makeHandler (ตาราง READ_SCHEMAS) · เรียกนอก makeHandler = เส้นเขียน (fail-closed)
 * @returns {Promise<{ref, franchise, access}>}
 */
async function readGate(getter, franchiseId, uid, opts) {
  const ref = db.collection("franchise").doc(franchiseId);
  const [fSnap, rSnap] = await Promise.all([getter(ref), getter(WR.rosterRef(db))]);
  if (!fSnap.exists) refuse(deny(404, "franchise_not_found", "ไม่พบแฟรนไชส์"));
  const franchise = fSnap.data() || {};
  const v = franchiseAccessOf({ franchise, uid, roster: WR.snapToRoster(rSnap) });
  if (!v.ok) refuse(v);
  const mode = MODE.getStore() || {};
  const r = needRight(v.access, { ...(opts || {}), read: mode.read === true, watcherWrite: mode.watcherWrite === true });
  if (r) refuse(r);
  return { ref, franchise, access: v.access };
}

/** adminTrail(access) — ช่องที่เพิ่มบนเอกสารที่ root เขียน (ชื่อ byAdmin/adminUid คงเดิม · ข้อ 5) */
const adminTrail = (access) => (access && access.byAdmin ? { byAdmin: true, adminUid: access.uid } : {});
const adminFlag = (access) => (access && access.byAdmin ? { byAdmin: true } : {});
/** staffFlag(access) — ธงในคำตอบให้เว็บรู้ระดับ: root = {byAdmin, root} · watcher = {watcher, readOnly} · คนทั่วไป = {} */
const staffFlag = (access) => {
  if (access && access.byAdmin) return { byAdmin: true, root: true };
  if (access && access.watcher) return { watcher: true, readOnly: true };
  return {};
};

/** เวลาเป็น ISO (Timestamp / Date) · อ่านไม่ได้ = null */
function isoOf(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v && typeof v.toMillis === "function") { const ms = v.toMillis(); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; }
  if (v && typeof v.toDate === "function") { const d = v.toDate(); return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null; }
  return null;
}

/** แถวพนักงานที่คืน/เขียน: เฉพาะช่องของแถว (SF-02 · เดิมคัด profile ทั้งก้อน รวม port currentLogin birthday) */
function staffRow(r) {
  const out = { id: str(r.id), name: str(r.name), tel: str(r.tel), email: str(r.email), imageId: str(r.imageId), rights: arr(r.rights).filter((x) => typeof x === "string") };
  if (typeof r.status === "string") out.status = r.status;
  return out;
}

/** category ของสินค้าคลัง → array ของ id (รับรูปเดิม 2 แบบ · ST-107) */
function categoryIdsOf(category) {
  return arr(category).map((c) => (typeof c === "string" ? c : isObj(c) && typeof c.id === "string" ? c.id : null)).filter((x) => x);
}
const isLegacyCategory = (category) => arr(category).some((c) => typeof c !== "string");

/** node ทุกตัวของต้นหมวด (Map id → node) */
function categoryNodes(tree) {
  const map = new Map();
  for (const lv of arr(tree)) for (const n of arr(isObj(lv) ? lv.value : null)) if (isObj(n) && typeof n.id === "string") map.set(n.id, n);
  return map;
}

/**
 * categoryPathProblem(ids, tree) — สายหมวดของสินค้าถูกต้องไหม: ตัวที่ i อยู่ชั้น i+1 และ aboveId = ids[0..i) (Modal_Warehouse B1)
 * @returns {null | {reason:'not_found'|'bad_path', categoryId}}
 */
function categoryPathProblem(ids, tree) {
  const nodes = categoryNodes(tree);
  for (let i = 0; i < ids.length; i++) {
    const n = nodes.get(ids[i]);
    if (!n) return { reason: "not_found", categoryId: ids[i] };
    const above = arr(n.aboveId);
    if (Number(n.level) !== i + 1 || above.length !== i || above.some((a, k) => a !== ids[k])) return { reason: "bad_path", categoryId: ids[i] };
  }
  return null;
}

/** เทียบค่าลึกแบบ JSON (คีย์ไม่สนลำดับ) */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (isObj(v)) {
    const iso = isoOf(v);
    if (iso) return iso;
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canon(v[k]);
    return out;
  }
  return v;
}
const sameValue = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/**
 * makeHandler(schemaName, work) → factory(deps) → handler(req,res)
 *   401 no_auth → 400 invalid_request → work({uid, input, now}) คืน body ของ 200 · Refusal = ส่ง deny · อื่น = 500
 *   schema อ่านจาก @shopchamp/schema ตอนเรียก (ชื่อไม่มีใน vendor = 500 ไม่ผ่านเงียบ)
 */
function makeHandler(schemaName, work) {
  return function factory(deps) {
    return async function handler(req, res) {
      try {
        const uid = uidOf(req);
        if (!uid) return sendDeny(res, deny(401, "no_auth"));
        const schema = require("@shopchamp/schema")[schemaName];
        if (!schema) throw new Error(`@shopchamp/schema ไม่มี ${schemaName}`);
        const body = isObj(req && req.body) ? req.body : {};
        const input = parseOr400(schema, body, res);
        if (!input) return undefined;
        const now = await readNow(deps);
        return ok(res, await MODE.run(modeOf(schemaName), () => work({ uid, input, now, deps })));
      } catch (e) {
        if (e instanceof Refusal) return sendDeny(res, e.deny);
        return internalError(res, e);
      }
    };
  };
}

module.exports = {
  makeHandler,
  RIGHT, ALL_RIGHTS, Refusal, refuse, uidOf, franchiseAccessOf, needRight, readGate, adminTrail, adminFlag, staffFlag, isStaff,
  READ_SCHEMAS, WATCHER_WRITE_SCHEMAS,
  isoOf, staffRow, categoryIdsOf, isLegacyCategory, categoryNodes, categoryPathProblem, sameValue, isObj, str, arr,
};
