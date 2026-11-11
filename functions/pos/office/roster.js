// pos/office/roster — Watcher Console ของ shopchampoffice: ดูทะเบียน · หาคนจากอีเมล · บันทึกทั้งชุด (DEV-0003)
//
// สัญญา: shopchamp-center/api/office.rosterGet.yaml · office.resolveEmail.yaml · office.rosterSave.yaml
// ที่เก็บ: watcher/roster (doc เดียวกับที่ pos/_shared/watcherRoster.js ตัดสินทีมงานทุกคำขอ) · ไม่มีสะพานข้าม project
//   ⇒ บันทึกสำเร็จ = มีผลทันทีกับคำขอถัดไปของ API ใหม่ · "สถานะการเผยแพร่" = ของที่อยู่บน doc ตอนนี้ (ใคร เมื่อไร ทางไหน)
//
// rosterGet     watcher + root · คืนรายชื่อตามที่ server ตัดสินจริง (ระดับจาก rootUids · ชื่อ/อีเมลจาก people)
// resolveEmail  root · ยังไม่มีทะเบียนพนักงานบริษัท ⇒ root พิมพ์อีเมล → หาใน Firebase Auth → คืน uid/ชื่อให้ยืนยัน (ไม่เขียนอะไร)
// rosterSave    root · ส่งทั้งชุด แทนที่ทั้ง doc (การถอดถึงปลายทางแน่นอน) · ไม่ใช้ passkey แล้ว (Pack ถอด 2026-11-11)
//   ลำดับ: token → รูปคำขอ → root → ด่านเดียวกับ watcher-publish.js (uid · ซ้ำ · level · root ≤ 10) → expectCount → ว่างต้อง allowEmpty
//          → ตรวจลายนิ้ว (กิน challenge) → uid ต้องมีใน Firebase Auth
//          (ถอด/ลดระดับตัวเองได้ · จอเตือนแรง · ไม่ปัดที่ server เพราะรายชื่อว่างที่ติ๊กยืนยันต้องบันทึกได้ — คำถาม Pack ข้อ 3)
//          → transaction: ของบนฐานต้องเป็นชุดที่จอโหลดมา (baseRosterSha) ไม่งั้น 409 roster_changed
//             เขียน watcher/roster ทั้งชุด + watcherRosterLog/{id} + officeAudit/{id} ใน commit เดียว
//   ถูกปัดหลังแตะนิ้วแล้ว = ลง officeAudit result 'rejected' (รู้ตัวคนกดแน่นอน)
//   รูป doc ตรวจด้วย WatcherRosterDoc ของ @shopchamp/schema ก่อนเขียน (ผิดรูป = 500 ไม่เขียน)
"use strict";

const { db } = require("../../firebase");
const { OfficeRosterGetRequest, OfficeResolveEmailRequest, OfficeRosterSaveRequest, WatcherRosterDoc } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const WR = require("../_shared/watcherRoster");
const S = require("./_officeStore");
const C = require("./_officeCore");

const ROSTER_LOG = "watcherRosterLog";

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

/** รายชื่อสำหรับจอ · ระดับ/สมาชิกภาพมาจากตัวตัดสินจริง (parseRoster) ไม่ใช่จาก people[] */
function viewOf(data) {
  const parsed = WR.parseRoster(data);
  const people = data && Array.isArray(data.people) ? data.people : [];
  const byUid = new Map(people.filter((p) => p && typeof p.uid === "string").map((p) => [p.uid, p]));
  const rows = [...parsed.uids].sort().map((uid) => {
    const p = byUid.get(uid) || {};
    return { uid, email: typeof p.email === "string" ? p.email : "", name: typeof p.name === "string" ? p.name : "", level: parsed.rootUids.has(uid) ? "root" : "watcher" };
  });
  return {
    exists: !!data,
    people: rows,
    count: rows.length,
    rootCount: rows.filter((r) => r.level === "root").length,
    rosterSha: data && typeof data.rosterSha === "string" ? data.rosterSha : "",
    publishedAt: data ? C.isoOf(data.publishedAt) : null,
    publishedBy: data && typeof data.publishedBy === "string" ? data.publishedBy : null,
    via: data && typeof data.via === "string" ? data.via : null,
    // people[] บนฐานไม่ตรงตัวตัดสิน (แก้มือ/ผิดรูป) = จอต้องเตือน
    mismatch: !!data && (people.length !== rows.length || rows.some((r) => !byUid.has(r.uid))),
  };
}

function rosterGet() {
  return wrap(async (req, res) => {
    S.callerOf(req);
    if (!parseOr400(OfficeRosterGetRequest, req.body, res)) return undefined;
    const g = await S.gate(req, "staff");
    return ok(res, { ...viewOf(g.roster), canEdit: g.role === WR.ROLE.ROOT, rootMax: C.ROOT_MAX });
  });
}

function resolveEmail(deps) {
  return wrap(async (req, res) => {
    S.callerOf(req);
    const input = parseOr400(OfficeResolveEmailRequest, req.body, res);
    if (!input) return undefined;
    const g = await S.gate(req, "root");
    const tools = S.toolsOf(deps);
    const u = await tools.lookupUserByEmail(input.email);
    if (!u || typeof u.uid !== "string" || !u.uid) S.refuse(404, "user_not_found", "ไม่พบบัญชีที่ใช้อีเมลนี้ใน Shopchamp · ให้เจ้าตัวสมัคร/เข้าแอปด้วยอีเมลนี้ก่อน");
    if (!C.UID_RE.test(u.uid)) S.refuse(422, "uid_unsupported", "บัญชีนี้มี uid รูปที่ทะเบียนรับไม่ได้");
    const view = viewOf(g.roster);
    const row = view.people.find((p) => p.uid === u.uid);
    return ok(res, { uid: u.uid, email: u.email || input.email, name: u.displayName || "", disabled: !!u.disabled, inRoster: !!row, level: row ? row.level : null });
  });
}

function rosterSave(deps) {
  return wrap(async (req, res) => {
    const caller = S.callerOf(req);
    const input = parseOr400(OfficeRosterSaveRequest, req.body, res);
    if (!input) return undefined;
    const now = await readNow(deps);
    await S.gate(req, "root");
    const tools = S.toolsOf(deps);

    // ด่านล้วน — ตัวเดียวกับ watcher-publish.js
    const checked = C.checkPeople(input.people);
    if (checked.problems.length) S.refuse(400, checked.problems[0].code, checked.problems[0].message, { problems: checked.problems });
    if (input.expectCount !== checked.people.length) S.refuse(400, "count_mismatch", `จำนวนที่จอเห็น (${input.expectCount}) ไม่ตรงรายชื่อที่ส่ง (${checked.people.length})`);
    if (!checked.people.length && input.allowEmpty !== true) S.refuse(400, "empty_needs_confirm", "รายชื่อว่าง = ไม่มีทีมงานเลย · ต้องติ๊กยืนยัน");

    const actor = caller;
    const reject = async (status, code, message, extra) => {
      await S.auditOutside({ action: "watcher.roster.save", result: "rejected", actor, now, extra: { rejectCode: code } });
      S.refuse(status, code, message, extra);
    };

    const uids = checked.people.map((p) => p.uid);
    const looked = uids.length ? await tools.lookupUsers(uids) : { users: [], missing: [] };
    const missing = Array.isArray(looked && looked.missing) ? looked.missing : uids;
    if (missing.length) await reject(422, "uid_not_found", `uid ที่ไม่มีใน Firebase Auth: ${missing.join(", ")}`, { missing });
    const emails = {};
    for (const u of looked.users || []) emails[u.uid] = typeof u.email === "string" ? u.email.trim().toLowerCase() : "";

    const next = rosterDocFor(checked.people, emails, actor, now);
    const ref = WR.rosterRef(db);
    const logId = `${S.stamp(now)}_office_${caller.uid}`;
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const live = snap && snap.exists ? snap.data() || {} : null;
      const liveSha = live && typeof live.rosterSha === "string" ? live.rosterSha : "";
      if (liveSha !== input.baseRosterSha) return { changed: true };
      const d = C.diffRoster(live, next);
      tx.set(ref, next);
      tx.create(db.collection(ROSTER_LOG).doc(logId), {
        by: next.publishedBy, byUid: caller.uid, via: "office", rosterSha: next.rosterSha, at: now,
        prev: live ? { uids: live.uids || [], rootUids: live.rootUids || [], rosterSha: liveSha } : null,
        next: { uids: next.uids, rootUids: next.rootUids }, added: d.added, removed: d.removed, levelChanged: d.levelChanged,
      });
      tx.create(S.auditRef(now, caller.uid, "watcher.roster.save"), S.auditEntry({
        action: "watcher.roster.save", result: "ok", actor, now,
        extra: { count: next.count, rootCount: next.rootCount, rosterSha: next.rosterSha, added: d.added, removed: d.removed, levelChanged: d.levelChanged, rosterLogId: logId },
      }));
      return { changed: false, d };
    });
    if (out.changed) await reject(409, "roster_changed", "ทะเบียนถูกแก้จากที่อื่นหลังจากจอโหลด · โหลดใหม่แล้วแก้อีกครั้ง");
    return ok(res, {
      count: next.count, rootCount: next.rootCount, rosterSha: next.rosterSha, publishedAt: now.toISOString(),
      added: out.d.added, removed: out.d.removed, levelChanged: out.d.levelChanged, rosterLogId: logId,
    });
  });
}

/** doc ปลายทางทั้งก้อน · ตรวจรูปด้วย schema กลางก่อนเขียน (ผิดรูป = throw → 500 ไม่เขียน) */
function rosterDocFor(people, emails, actor, now) {
  const doc = { ...C.rosterDoc(people, emails), publishedBy: actor.email || actor.uid, publishedByUid: actor.uid, via: "office", publishedAt: now };
  const r = WatcherRosterDoc.safeParse(doc);
  if (!r.success) throw new Error("office rosterSave: doc ผิดรูป " + r.error.issues.map((i) => i.message).join(" · "));
  return doc;
}

module.exports = { rosterGet, resolveEmail, rosterSave, viewOf, rosterDocFor };
