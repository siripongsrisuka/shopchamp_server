// เทส shopchampoffice (DEV-0003 · Watcher Console) · ของที่ชุด case ของสัญญา office.*.yaml คุมไม่ได้
//   ① ไม่มี passkey แล้ว (Pack ถอด 2026-11-11): whoami ไม่คืนกุญแจ · ส่งช่อง passkey มา = 400 invalid_request ไม่เขียนอะไร
//   ② ฐานปลอมที่ "เขียนลงจริง" (ต่างจากของ harness ที่บันทึกแต่ไม่ลง) ⇒ เดินต่อหลายขั้นได้ · ตัวตัดสินทีมงานอ่านผลที่เขียนจริง
//   ③ ด่านทะเบียนตรงกับ shopchamp-center/gate/watcher-publish.js ตัวจริง (ถ้ามี center ข้าง ๆ) · rosterSha สูตรเดียวกับ ledger-sign
//   รัน: node --test pos/office/office.test.js · ❌ ไม่แตะ Firestore/Auth จริง (แทน functions/firebase ใน require.cache)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

// ── ฐานปลอมที่เขียนลงจริง ─────────────────────────────────────────────────
function memDb() {
  const store = new Map(); // path → data
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const snap = (p, id) => ({ exists: store.has(p), id, data: () => clone(store.get(p)) });
  const docRef = (coll, id) => {
    const p = `${coll}/${id}`;
    return {
      id, path: p,
      get: async () => snap(p, id),
      set: async (d) => { store.set(p, clone(d)); },
      create: async (d) => { if (store.has(p)) throw new Error("ALREADY_EXISTS " + p); store.set(p, clone(d)); },
      update: async (d) => { if (!store.has(p)) throw new Error("NOT_FOUND " + p); store.set(p, { ...store.get(p), ...clone(d) }); },
      delete: async () => { store.delete(p); },
    };
  };
  const coll = (c) => {
    let n = 0;
    const q = (filters) => ({
      where: (f, op, v) => q([...filters, [f, op, v]]),
      get: async () => {
        const docs = [...store.entries()].filter(([p]) => p.startsWith(c + "/") && p.split("/").length === 2)
          .filter(([, d]) => filters.every(([f, op, v]) => op === "==" && d[f] === v))
          .map(([p, d]) => ({ id: p.split("/")[1], exists: true, data: () => clone(d) }));
        return { empty: !docs.length, size: docs.length, docs };
      },
    });
    return { doc: (id) => docRef(c, id || `auto${++n}`), where: (f, op, v) => q([[f, op, v]]), get: () => q([]).get() };
  };
  const db = {
    collection: coll,
    runTransaction: async (fn) => {
      const ops = [];
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, d) => { ops.push(() => ref.set(d)); return tx; },
        create: (ref, d) => { ops.push(() => ref.create(d)); return tx; },
        update: (ref, d) => { ops.push(() => ref.update(d)); return tx; },
        delete: (ref) => { ops.push(() => ref.delete()); return tx; },
      };
      const creates = [];
      const tx2 = { ...tx, create: (ref, d) => { creates.push(ref.path); ops.push(() => ref.create(d)); return tx2; } };
      const out = await fn(tx2);
      // create ที่ชนต้องล้มทั้งก้อน (แบบ Firestore) ⇒ ตรวจก่อนลงจริง
      for (const p of creates) if (store.has(p)) throw new Error("ALREADY_EXISTS " + p);
      for (const op of ops) await op();
      return out;
    },
  };
  return { db, store };
}

let M = {};
let mem;
function fresh(seed) {
  mem = memDb();
  for (const [p, d] of Object.entries(seed || {})) mem.store.set(p, structuredClone(d));
  const fbAbs = require.resolve("../../firebase");
  require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: mem.db, admin: {}, bucket: {} } };
  for (const f of ["./_officeStore", "./whoami", "./roster"]) delete require.cache[require.resolve(f)];
  M = { ...require("./whoami"), ...require("./roster") };
}

const ROOT = "rootUid000000000000000001";
const WATCH = "watchUid00000000000000001";
const NEWBIE = "newUid0000000000000000001";
const OUT = "outUid0000000000000000001";
const USERS = {
  [ROOT]: { uid: ROOT, email: "root@shopchamp.test", displayName: "Root" },
  [WATCH]: { uid: WATCH, email: "watch@shopchamp.test", displayName: "Watch" },
  [NEWBIE]: { uid: NEWBIE, email: "new@shopchamp.test", displayName: "New" },
};
const rosterSeed = () => ({
  "watcher/roster": {
    uids: [ROOT, WATCH].sort(), rootUids: [ROOT],
    people: [{ uid: ROOT, email: "root@shopchamp.test", name: "Root", level: "root" }, { uid: WATCH, email: "watch@shopchamp.test", name: "Watch", level: "watcher" }].sort((a, b) => (a.uid < b.uid ? -1 : 1)),
    count: 2, rootCount: 1, rosterSha: "a".repeat(64), via: "center-script", publishedBy: "pack@x",
  },
});

const clock = new Date("2026-11-10T03:00:00.000Z");
const deps = () => ({
  now: () => new Date(clock.getTime()),
  lookupUserByEmail: async (e) => Object.values(USERS).find((u) => u.email === e) || null,
  lookupUsers: async (uids) => ({ users: uids.filter((u) => USERS[u]).map((u) => USERS[u]), missing: uids.filter((u) => !USERS[u]) }),
});
async function call(name, body, uid, extraDeps) {
  let code = 0; let out = null;
  const res = { status(c) { code = c; return this; }, json(b) { out = b; return this; } };
  await M[name]({ ...deps(), ...(extraDeps || {}) })({ body, auth: uid ? { uid, email: USERS[uid] ? USERS[uid].email : null } : undefined }, res);
  return { code, body: out };
}

const people = () => [{ uid: ROOT, name: "Root", level: "root" }, { uid: WATCH, name: "Watch", level: "watcher" }];

// ── ② ทะเบียน ──────────────────────────────────────────────────────────────
test("root เพิ่ม watcher 1 คน → doc ทั้งชุด · log · audit · ตัวตัดสินทีมงานเห็นคนใหม่ทันที", async () => {
  fresh(rosterSeed());
  const before = mem.store.get("watcher/roster").rosterSha;
  const r = await call("rosterSave", { people: [...people(), { uid: NEWBIE, name: "New", level: "watcher" }], expectCount: 3, baseRosterSha: before }, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.added, [{ uid: NEWBIE, level: "watcher" }]);
  const doc = mem.store.get("watcher/roster");
  assert.equal(doc.via, "office");
  assert.equal(doc.publishedByUid, ROOT);
  assert.equal(doc.count, 3);
  assert.equal(doc.people.find((p) => p.uid === NEWBIE).email, "new@shopchamp.test");
  const WR = require("../_shared/watcherRoster");
  assert.equal(WR.staffRoleOf(doc, NEWBIE), "watcher");
  assert.ok([...mem.store.keys()].some((k) => k.startsWith("watcherRosterLog/")));
  const audit = [...mem.store.entries()].find(([k, v]) => k.startsWith("officeAudit/") && v.action === "watcher.roster.save");
  assert.equal(audit[1].result, "ok");
  assert.equal(audit[1].passkeyCredentialId, null, "ไม่มีกุญแจแล้ว · ช่องเดิมเป็น null");
  const log = [...mem.store.entries()].find(([k]) => k.startsWith("watcherRosterLog/"))[1];
  assert.equal(log.passkeyCredentialId, undefined);
  // ดูผ่าน rosterGet ด้วย watcher (อ่านอย่างเดียว)
  const g = await call("rosterGet", {}, WATCH);
  assert.equal(g.code, 200);
  assert.equal(g.body.canEdit, false);
  assert.equal(g.body.count, 3);
});

test("ทะเบียนถูกแก้ระหว่างทาง (baseRosterSha ไม่ตรง) → 409 roster_changed ไม่เขียน · audit rejected", async () => {
  fresh(rosterSeed());
  const r = await call("rosterSave", { people: people(), expectCount: 2, baseRosterSha: "b".repeat(64) }, ROOT);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "roster_changed");
  assert.equal(mem.store.get("watcher/roster").via, "center-script");
  assert.ok([...mem.store.values()].some((v) => v && v.action === "watcher.roster.save" && v.result === "rejected" && v.rejectCode === "roster_changed"));
});

test("ถอดตัวเอง (รายชื่อว่าง + ติ๊กยืนยัน) → 200 · ไม่ติ๊ก → 400 empty_needs_confirm", async () => {
  fresh(rosterSeed());
  const sha = mem.store.get("watcher/roster").rosterSha;
  const no = await call("rosterSave", { people: [], expectCount: 0, baseRosterSha: sha }, ROOT);
  assert.equal(no.code, 400);
  assert.equal(no.body.error, "empty_needs_confirm");
  const r = await call("rosterSave", { people: [], expectCount: 0, allowEmpty: true, baseRosterSha: sha }, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(mem.store.get("watcher/roster").count, 0);
  assert.equal((await call("rosterGet", {}, ROOT)).body.error, "office_no_access");
});

test("uid ที่ไม่มีใน Firebase Auth → 422 uid_not_found ไม่เขียน", async () => {
  fresh(rosterSeed());
  const sha = mem.store.get("watcher/roster").rosterSha;
  const r = await call("rosterSave", { people: [...people(), { uid: OUT, name: "?", level: "watcher" }], expectCount: 3, baseRosterSha: sha }, ROOT);
  assert.equal(r.code, 422);
  assert.equal(r.body.error, "uid_not_found");
  assert.equal(mem.store.get("watcher/roster").count, 2);
});

test("ด่านคน: คนนอก whoami 200 none · rosterGet 403 office_no_access · watcher หาอีเมล/บันทึก 403 root_required · ทะเบียนไม่มี = ไม่มีใครเข้า", async () => {
  fresh(rosterSeed());
  const w = await call("whoami", {}, OUT);
  assert.equal(w.code, 200);
  assert.equal(w.body.staffRole, "none");
  assert.equal(w.body.canEdit, false);
  assert.equal(w.body.passkeys, undefined);
  assert.equal((await call("rosterGet", {}, OUT)).body.error, "office_no_access");
  assert.equal((await call("resolveEmail", { email: "new@shopchamp.test" }, WATCH)).body.error, "root_required");
  const wsave = await call("rosterSave", { people: people(), expectCount: 2, baseRosterSha: "a".repeat(64) }, WATCH);
  assert.equal(wsave.code, 403);
  assert.equal(wsave.body.error, "root_required");
  assert.equal(mem.store.get("watcher/roster").via, "center-script");
  fresh({});
  assert.equal((await call("whoami", {}, ROOT)).body.staffRole, "none");
  assert.equal((await call("rosterGet", {}, ROOT)).body.error, "office_no_access");
  assert.equal((await call("whoami", {}, undefined)).code, 401);
});

test("resolveEmail: เจอ = uid/ชื่อ/อยู่ในทะเบียนไหม · ไม่เจอ = 404 · อีเมลตัวใหญ่/ช่องว่างถูกทำให้เป็นรูปเดียว", async () => {
  fresh(rosterSeed());
  const r = await call("resolveEmail", { email: "  NEW@shopchamp.test " }, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.uid, NEWBIE);
  assert.equal(r.body.inRoster, false);
  const w = await call("resolveEmail", { email: "watch@shopchamp.test" }, ROOT);
  assert.equal(w.body.inRoster, true);
  assert.equal(w.body.level, "watcher");
  const n = await call("resolveEmail", { email: "nobody@shopchamp.test" }, ROOT);
  assert.equal(n.code, 404);
});

// ── ① ไม่มี passkey แล้ว ───────────────────────────────────────────────────
test("ไม่มี passkey: whoami ของ root ไม่มี passkeys/passkeyMax · rosterSave ที่ส่งช่อง passkey = 400 invalid_request ไม่เขียนอะไร", async () => {
  fresh(rosterSeed());
  const w = await call("whoami", {}, ROOT);
  assert.equal(w.code, 200, JSON.stringify(w.body));
  assert.equal(w.body.staffRole, "root");
  assert.equal(w.body.canEdit, true);
  assert.ok(!("passkeys" in w.body), "ไม่มีช่อง passkeys");
  assert.ok(!("passkeyMax" in w.body), "ไม่มีช่อง passkeyMax");
  const before = new Map([...mem.store.entries()].map(([k, v]) => [k, structuredClone(v)]));
  const sha = mem.store.get("watcher/roster").rosterSha;
  const r = await call("rosterSave", {
    people: [...people(), { uid: NEWBIE, name: "New", level: "watcher" }], expectCount: 3, baseRosterSha: sha,
    passkey: { origin: "http://localhost:5173", authResp: { id: "x", rawId: "x", type: "public-key", response: {}, clientExtensionResults: {} } },
  }, ROOT);
  assert.equal(r.code, 400);
  assert.equal(r.body.error, "invalid_request");
  assert.deepEqual(new Map(mem.store), before, "ไม่เขียนทะเบียน · log · audit");
});

// ── ③ ด่านเดียวกับ center ──────────────────────────────────────────────────
const CENTER_GATE = path.resolve(__dirname, "../../../../shopchamp-center/gate");
test("ด่านทะเบียน = watcher-publish.js › parseRosterFile · rosterSha/rosterDoc = สูตรเดียวกับ center", (t) => {
  if (!fs.existsSync(path.join(CENTER_GATE, "watcher-publish.js"))) { t.skip("ไม่พบ shopchamp-center ข้าง ๆ"); return; }
  const WP = require(path.join(CENTER_GATE, "watcher-publish.js"));
  const LS = require(path.join(CENTER_GATE, "ledger-sign.js"));
  const C = require("./_officeCore");
  const YAML = require(require.resolve("yaml", { paths: [CENTER_GATE] }));
  const ok = [ROOT, WATCH, NEWBIE].map((uid, i) => ({ uid, name: `n${i}`, level: i === 0 ? "root" : "watcher" }));
  const roots11 = Array.from({ length: 11 }, (_, i) => ({ uid: `rootUid${String(i).padStart(18, "0")}`, name: "", level: "root" }));
  const cases = [
    ok, [], roots11, roots11.slice(0, 10),
    [...ok, { ...ok[1] }],
    [{ uid: "short", name: "", level: "watcher" }],
    [{ uid: ROOT, name: "", level: "admin" }],
    [{ uid: "has-dash-000000000000000", name: "", level: "watcher" }],
  ];
  for (const people of cases) {
    const mine = C.checkPeople(people);
    const theirs = WP.parseRosterFile(YAML.stringify({ people }));
    assert.equal(mine.problems.length > 0, theirs.problems.length > 0, `ตัดสินต่างกัน: ${JSON.stringify(people).slice(0, 120)} · office ${JSON.stringify(mine.problems)} · center ${JSON.stringify(theirs.problems)}`);
    if (!mine.problems.length) {
      assert.equal(C.rosterManifest(mine.people), LS.rosterManifest(theirs.people));
      assert.deepEqual(C.rosterDoc(mine.people, { [ROOT]: "r@x" }), WP.rosterDoc(theirs.people, { [ROOT]: "r@x" }));
    }
  }
});
