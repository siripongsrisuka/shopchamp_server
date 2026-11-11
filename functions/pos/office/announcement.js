// pos/office/announcement — หน้า "ประกาศถึงร้าน" (Marketing) ของ shopchampoffice + ประเภทร้าน (DEV-0003 0e · Pack สั่ง 2026-11-11)
//
// แบบ: lanes/dev/source/office-announcement-design.md · Pack เคาะ 1a (ชั่วคราว + ถาวรตามเงื่อนไข) · 2a (แบนเนอร์/ป๊อปอัป/กล่องข่าว/ปักแบนเนอร์) · 3b (ทุกร้าน/เลือกร้าน/กรอง + เจ้าของ/ทุกคน + ประเภทร้าน)
// สัญญา (ร่าง รอ Pack เซ็น): shopchamp-center/api/office.ann*.yaml (8 ไฟล์) · ตัวสร้างสัญญา: lanes/dev/source/office-announcement-cases.js
//
// ที่เก็บ (server เท่านั้น · rules ไม่มี match = ปัด client ทุกคน):
//   announcement/{id}            ใบประกาศ · id = clientRequestId (กันกดซ้ำ) · ตรวจรูปด้วย logic.announcementSaveInput ตัวเดียว
//   announcement/{id}/seen/{uid} แอปเขียนผ่าน pos/announcement/seen.js · ที่นี่นับอย่างเดียว (count aggregation)
//   shopCategory/{id}            {name, order, active} · shopCategoryTag/{shopId} {categoryIds, updatedAt, updatedBy}
//   officeAudit                  ทุกการเขียนที่สำเร็จ (transaction เดียวกับการเขียน)
//
// สิทธิ์ (S.gate จาก watcher/roster ทุกคำขอ): annList · annCategoryList · annShopFind = ทีมงาน (watcher + root) · ที่เหลือ = root · ไม่ใช้ passkey
// คำขอ: strict (ช่องเกิน = 400 invalid_request) · ลำดับ: รูปคำขอ → นาฬิกา → ด่านคน → ฐาน
"use strict";

const crypto = require("crypto");
const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const WR = require("../_shared/watcherRoster");
const S = require("./_officeStore");
const C = require("./_officeCore");

const ANN = "announcement";
const CATS = "shopCategory";
const TAGS = "shopCategoryTag";
const IMAGE_PREFIX = "https://firebasestorage.googleapis.com/v0/b/shopcham-24b0b.appspot.com/o/announcement%2F";
const LIST_CAP = 500;
const FIND_LIMIT = 10;
const CAT_NAME_MAX = 60;
const EPOCH = new Date(0);

const str = (v) => (typeof v === "string" ? v : "");
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const has = (b, k) => Object.prototype.hasOwnProperty.call(b, k);
const kindOf = (a) => (a && a.kind === "evergreen" ? "evergreen" : "campaign");

// ── ตรวจรูปคำขอ (strict · field เกิน = 400) ─────────────────────────────────
function bad(message) { S.refuse(400, "invalid_request", message); }
function bodyOf(req) {
  const b = req ? req.body : undefined;
  if (b === undefined || b === null) return {};
  if (!isObj(b)) bad("คำขอต้องเป็น object");
  return b;
}
function onlyKeys(b, allowed) {
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length) bad(`ไม่รับช่อง: ${extra.join(", ")}`);
}
function idOf(v, label) {
  if (typeof v !== "string" || v === "" || v.length > logic.ANNOUNCEMENT_LIMITS.id || v.includes("/") || v === "." || v === "..") bad(`${label} ผิดรูป`);
  return v;
}
function idsOf(v, label, max) {
  if (!Array.isArray(v)) bad(`${label} ต้องเป็นรายการ`);
  v.forEach((x) => idOf(x, label));
  if (new Set(v).size !== v.length) bad(`${label} มีรหัสซ้ำ`);
  if (v.length > max) bad(`${label} ได้ไม่เกิน ${max} รายการ`);
  return v.slice();
}

// ── ของร่วม ────────────────────────────────────────────────────────────────
function wrap(run) {
  return async function handler(req, res) {
    try {
      return await run(req, res);
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}
/** ชื่อผู้กด: ชื่อในทะเบียนทีมงาน → อีเมล → uid */
function actorOf(g) {
  const people = g.roster && Array.isArray(g.roster.people) ? g.roster.people : [];
  const p = people.find((x) => x && x.uid === g.uid);
  return { uid: g.uid, email: g.email || "", name: (p && str(p.name).trim()) || g.email || g.uid };
}
function audit(tx, now, actor, action, qualifier, extra) {
  tx.create(S.auditRef(now, actor.uid, action, qualifier), S.auditEntry({ action, result: "ok", actor, now, extra }));
}
/** ประเภทร้านที่อ้างต้องมีอยู่ (ไม่ดูสวิตช์เปิดใช้ · ร้านที่ติดป้ายที่ปิดแล้วบันทึกซ้ำต้องไม่เด้ง) */
async function requireCategories(ids) {
  if (!ids.length) return;
  const snaps = await db.getAll(...ids.map((id) => db.collection(CATS).doc(id)));
  const missing = ids.filter((id, i) => !(snaps[i] && snaps[i].exists));
  if (missing.length) S.refuse(409, "ann_category_not_found", "ไม่พบประเภทร้านที่เลือก (อาจถูกลบไปแล้ว) · โหลดใหม่แล้วลองอีกครั้ง", { missing });
}

// ── รูปคำตอบ ────────────────────────────────────────────────────────────────
const actorView = (x) => (isObj(x) ? { uid: str(x.uid), email: str(x.email), name: str(x.name) } : null);
async function statsOf(id) {
  try {
    const seen = db.collection(ANN).doc(id).collection("seen");
    const [read, popup] = await Promise.all([
      seen.where("readAt", ">=", EPOCH).count().get(),
      seen.where("popupSeenAt", ">=", EPOCH).count().get(),
    ]);
    return { read: read.data().count, popupSeen: popup.data().count };
  } catch (e) {
    try { console.error("office ann stats fail", id, e && e.message); } catch (_) { /* */ }
    return null;
  }
}
function itemOf(id, a, now) {
  const ch = isObj(a.channels) ? a.channels : {};
  const ever = kindOf(a) === "evergreen";
  return {
    id,
    kind: kindOf(a),
    title: str(a.title), body: str(a.body),
    images: Array.isArray(a.images) ? a.images.filter((u) => typeof u === "string") : [],
    buttonText: str(a.buttonText), buttonUrl: str(a.buttonUrl),
    channels: { banner: ch.banner === true, popup: ch.popup === true, inbox: ch.inbox === true },
    bannerSticky: a.bannerSticky === true,
    audience: isObj(a.audience) ? a.audience : null,
    startAt: ever ? null : C.isoOf(a.startAt), endAt: ever ? null : C.isoOf(a.endAt),
    trigger: ever && isObj(a.trigger) ? a.trigger : null,
    active: ever ? a.active === true : null,
    status: logic.announcementDisplayStatus({ ...a, kind: kindOf(a) }, now),
    createdAt: C.isoOf(a.createdAt), createdBy: actorView(a.createdBy),
    updatedAt: C.isoOf(a.updatedAt), cancelledAt: C.isoOf(a.cancelledAt),
  };
}

// ── handler: ประกาศ ──────────────────────────────────────────────────────────

function annList(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["kind"]);
    if (b.kind !== "campaign" && b.kind !== "evergreen") bad("kind ต้องเป็น campaign | evergreen");
    const now = await readNow(deps);
    const g = await S.gate(req, "staff");
    const snap = await db.collection(ANN).orderBy("createdAt", "desc").limit(LIST_CAP).get();
    const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
    const counts = { campaign: 0, evergreen: 0, all: 0, live: 0, scheduled: 0, ended: 0, cancelled: 0 };
    const mine = [];
    for (const d of docs) {
      const k = kindOf(d.data);
      counts[k] += 1;
      if (k !== b.kind) continue;
      const item = itemOf(d.id, d.data, now);
      counts.all += 1;
      counts[item.status] += 1;
      mine.push(item);
    }
    const items = await Promise.all(mine.map(async (it) => ({ ...it, stats: await statsOf(it.id) })));
    return ok(res, { items, counts, canEdit: g.role === WR.ROLE.ROOT, truncated: docs.length >= LIST_CAP });
  });
}

function annSave(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const b = bodyOf(req);
    const now = await readNow(deps);
    const editing = isObj(b) && b.id !== undefined && b.id !== null;
    const v = logic.announcementSaveInput(b, now, { imagePrefix: IMAGE_PREFIX, creating: !editing });
    if (!v.ok) bad(v.message);
    const g = await S.gate(req, "root");
    const actor = actorOf(g);
    await requireCategories(v.value.audience.shops.categoryIds);

    if (v.id === null) {
      const id = v.clientRequestId || crypto.randomUUID();
      const ref = db.collection(ANN).doc(id);
      const out = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap && snap.exists) {
          const by = (snap.data() || {}).createdBy;
          if (isObj(by) && by.uid === g.uid) return { id, created: false };
          S.refuse(409, "request_id_taken", "รหัสคำขอนี้ถูกใช้แล้ว · เริ่มสร้างใหม่อีกครั้ง");
        }
        tx.create(ref, { ...v.value, createdBy: actor, createdAt: now, updatedAt: now, updatedBy: actor, cancelledAt: null, cancelledBy: null });
        audit(tx, now, actor, "ann.create", id, { announcementId: id, kind: v.value.kind });
        return { id, created: true };
      });
      return ok(res, out);
    }

    const ref = db.collection(ANN).doc(v.id);
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap || !snap.exists) S.refuse(404, "announcement_not_found", "ไม่พบประกาศนี้ · โหลดใหม่แล้วลองอีกครั้ง");
      const prev = snap.data() || {};
      if (kindOf(prev) !== v.value.kind) S.refuse(409, "kind_locked", "เปลี่ยนชนิดประกาศของใบเดิมไม่ได้ · สร้างใบใหม่");
      if (v.value.kind === "campaign" && prev.status === "cancelled") S.refuse(409, "announcement_cancelled", "ประกาศนี้ถูกยกเลิกแล้ว แก้ไม่ได้");
      // ถาวรที่ปิดไว้แล้วเปิดกลับ = ล้างรอยยกเลิก
      const reopen = v.value.kind === "evergreen" && v.value.active === true && prev.active !== true ? { cancelledAt: null, cancelledBy: null } : {};
      tx.update(ref, { ...v.value, ...reopen, updatedAt: now, updatedBy: actor });
      audit(tx, now, actor, "ann.update", v.id, { announcementId: v.id, kind: v.value.kind });
      return { id: v.id, created: false };
    });
    return ok(res, out);
  });
}

function annCancel(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["id"]);
    const id = idOf(b.id, "id");
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const actor = actorOf(g);
    const ref = db.collection(ANN).doc(id);
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap || !snap.exists) S.refuse(404, "announcement_not_found", "ไม่พบประกาศนี้ · โหลดใหม่แล้วลองอีกครั้ง");
      const prev = snap.data() || {};
      const ever = kindOf(prev) === "evergreen";
      if (ever ? prev.active !== true : prev.status === "cancelled") return { already: true };
      const stamp = { cancelledAt: now, cancelledBy: actor, updatedAt: now, updatedBy: actor };
      tx.update(ref, ever ? { active: false, ...stamp } : { status: "cancelled", ...stamp });
      audit(tx, now, actor, "ann.cancel", id, { announcementId: id, kind: kindOf(prev) });
      return { already: false };
    });
    return ok(res, { id, status: "cancelled", already: out.already });
  });
}

// ── handler: ประเภทร้าน ──────────────────────────────────────────────────────

async function tagCount(categoryId) {
  const r = await db.collection(TAGS).where("categoryIds", "array-contains", categoryId).count().get();
  return r.data().count;
}

function annCategoryList(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    onlyKeys(bodyOf(req), []);
    await readNow(deps);
    const g = await S.gate(req, "staff");
    const snap = await db.collection(CATS).get();
    const rows = snap.docs.map((d) => {
      const c = d.data() || {};
      return { id: d.id, name: str(c.name), order: Number.isFinite(c.order) ? c.order : 0, active: c.active === true };
    });
    rows.sort((x, y) => x.order - y.order || x.name.localeCompare(y.name, "th"));
    const categories = await Promise.all(rows.map(async (c) => ({ ...c, count: await tagCount(c.id) })));
    return ok(res, { categories, canEdit: g.role === WR.ROLE.ROOT });
  });
}

function annCategorySave(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["id", "name", "active"]);
    const id = has(b, "id") ? idOf(b.id, "id") : null;
    if (typeof b.name !== "string") bad("name ต้องเป็นข้อความ");
    const name = b.name.trim();
    if (name.length < 1 || name.length > CAT_NAME_MAX) bad(`name ต้องยาว 1-${CAT_NAME_MAX} ตัว`);
    if (typeof b.active !== "boolean") bad("active ต้องเป็น true/false");
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const actor = actorOf(g);
    const col = db.collection(CATS);
    const out = await db.runTransaction(async (tx) => {
      const all = await tx.get(col);
      const docs = all.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
      if (id !== null && !docs.some((d) => d.id === id)) S.refuse(404, "ann_category_not_found", "ไม่พบประเภทร้านนี้ · โหลดใหม่แล้วลองอีกครั้ง");
      const key = name.toLowerCase();
      if (docs.some((d) => d.id !== id && str(d.data.name).trim().toLowerCase() === key)) S.refuse(409, "duplicate_name", "มีประเภทร้านชื่อนี้อยู่แล้ว");
      if (id !== null) {
        tx.update(col.doc(id), { name, active: b.active, updatedAt: now, updatedBy: actor });
        audit(tx, now, actor, "ann.category.save", id, { categoryId: id, name, active: b.active });
        return { id, created: false };
      }
      const ref = col.doc();
      const order = docs.reduce((m, d) => (Number.isFinite(d.data.order) && d.data.order >= m ? d.data.order + 1 : m), 0);
      tx.create(ref, { name, order, active: b.active, createdAt: now, updatedAt: now, updatedBy: actor });
      audit(tx, now, actor, "ann.category.create", null, { categoryId: ref.id, name, active: b.active, order });
      return { id: ref.id, created: true };
    });
    return ok(res, out);
  });
}

/** ประกาศที่ยังใช้ประเภทนี้อยู่ = ชั่วคราวที่ยังไม่ยกเลิกและยังไม่หมด · ถาวรที่เปิดอยู่ (ใบที่จบแล้วไม่กันลบ) */
async function annUsing(categoryId, now) {
  const snap = await db.collection(ANN).where("audience.shops.categoryIds", "array-contains", categoryId).get();
  return snap.docs.filter((d) => {
    const a = d.data() || {};
    if (kindOf(a) === "evergreen") return a.active === true;
    const st = logic.announcementDisplayStatus({ ...a, kind: "campaign" }, now);
    return st === "live" || st === "scheduled";
  }).length;
}

function annCategoryDelete(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["id"]);
    const id = idOf(b.id, "id");
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const actor = actorOf(g);
    const ref = db.collection(CATS).doc(id);
    const pre = await ref.get();
    if (!pre || !pre.exists) S.refuse(404, "ann_category_not_found", "ไม่พบประเภทร้านนี้ · โหลดใหม่แล้วลองอีกครั้ง");
    const [shops, announcements] = await Promise.all([tagCount(id), annUsing(id, now)]);
    if (shops || announcements) {
      S.refuse(409, "category_in_use", `ประเภทนี้ยังมีร้านติดป้าย ${shops} ร้าน · ประกาศที่ยังแสดงใช้อยู่ ${announcements} ใบ · เอาออกก่อนจึงลบได้`, { shops, announcements });
    }
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap || !snap.exists) S.refuse(404, "ann_category_not_found", "ไม่พบประเภทร้านนี้ · โหลดใหม่แล้วลองอีกครั้ง");
      tx.delete(ref);
      audit(tx, now, actor, "ann.category.delete", id, { categoryId: id, before: snap.data() || null });
    });
    return ok(res, { id, deleted: true });
  });
}

// ── handler: ร้าน ───────────────────────────────────────────────────────────

function shopView(id, s, tag) {
  const sc = s.scShopId;
  return {
    shopId: id,
    scShopId: typeof sc === "number" || (typeof sc === "string" && sc !== "") ? sc : null,
    name: str(s.name),
    categoryIds: tag && Array.isArray(tag.categoryIds) ? tag.categoryIds : [],
  };
}

function annShopFind(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["q"]);
    if (typeof b.q !== "string" || b.q.trim() === "" || b.q.trim().length > 128) bad("q ต้องเป็นเลขร้านหรือรหัสร้าน 1-128 ตัว");
    const q = b.q.trim();
    await readNow(deps);
    await S.gate(req, "staff");
    const shops = db.collection("shop");
    const found = new Map();
    // เลขร้าน (scShopId) ในฐานเป็นได้ทั้งตัวเลขและข้อความ ⇒ ค้นทั้ง 2 รูป · รหัส doc ตรงตัว
    const jobs = [];
    if (/^\d{1,12}$/.test(q)) {
      jobs.push(shops.where("scShopId", "==", Number(q)).limit(FIND_LIMIT).get(), shops.where("scShopId", "==", q).limit(FIND_LIMIT).get());
    }
    const byDoc = !q.includes("/") && q !== "." && q !== ".." ? shops.doc(q).get() : Promise.resolve(null);
    const [direct, ...lists] = await Promise.all([byDoc, ...jobs]);
    if (direct && direct.exists) found.set(direct.id || q, direct.data() || {});
    for (const l of lists) for (const d of l.docs) if (!found.has(d.id)) found.set(d.id, d.data() || {});
    const ids = [...found.keys()].slice(0, FIND_LIMIT);
    const tags = ids.length ? await db.getAll(...ids.map((id) => db.collection(TAGS).doc(id))) : [];
    return ok(res, { shops: ids.map((id, i) => shopView(id, found.get(id), tags[i] && tags[i].exists ? tags[i].data() : null)) });
  });
}

function annShopTagSet(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const b = bodyOf(req);
    onlyKeys(b, ["shopId", "categoryIds"]);
    const shopId = idOf(b.shopId, "shopId");
    const categoryIds = idsOf(b.categoryIds, "categoryIds", logic.ANNOUNCEMENT_LIMITS.categoryIds);
    const now = await readNow(deps);
    const g = await S.gate(req, "root");
    const actor = actorOf(g);
    const shopSnap = await db.collection("shop").doc(shopId).get();
    if (!shopSnap || !shopSnap.exists) S.refuse(404, "shop_not_found", "ไม่พบร้านนี้");
    await requireCategories(categoryIds);
    const ref = db.collection(TAGS).doc(shopId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const before = snap && snap.exists && Array.isArray((snap.data() || {}).categoryIds) ? snap.data().categoryIds : [];
      tx.set(ref, { categoryIds, updatedAt: now, updatedBy: actor });
      audit(tx, now, actor, "ann.shop.tag", shopId, { shopId, before, after: categoryIds });
    });
    return ok(res, { shopId, categoryIds });
  });
}

module.exports = {
  ANN, CATS, TAGS, IMAGE_PREFIX, itemOf,
  annList, annSave, annCancel, annCategoryList, annCategorySave, annCategoryDelete, annShopFind, annShopTagSet,
};
