// เทส shopchampoffice (DEV-0003 · Watcher Console) · ของที่ชุด case ของสัญญา office.*.yaml คุมไม่ได้
//   ① พิธี WebAuthn ของจริง (@simplewebauthn/server ตัวจริง) กับกุญแจซอฟต์แวร์ในเทส: ลงทะเบียน → ยืนยัน → บันทึกทะเบียน
//      challenge ใช้ครั้งเดียว (ยิงซ้ำ = no_challenge) · ไม่แตะนิ้ว (UV=0) = ไม่ผ่าน · หมดอายุ 5 นาที · กุญแจของคนอื่นใช้ไม่ได้
//   ② ฐานปลอมที่ "เขียนลงจริง" (ต่างจากของ harness ที่บันทึกแต่ไม่ลง) ⇒ เดินต่อหลายขั้นได้ · ตัวตัดสินทีมงานอ่านผลที่เขียนจริง
//   ③ ด่านทะเบียนตรงกับ shopchamp-center/gate/watcher-publish.js ตัวจริง (ถ้ามี center ข้าง ๆ) · rosterSha สูตรเดียวกับ ledger-sign
//   รัน: node --test pos/office/office.test.js · ❌ ไม่แตะ Firestore/Auth จริง (แทน functions/firebase ใน require.cache)
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { isoCBOR } = require("@simplewebauthn/server/helpers");

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
  for (const f of ["./_officeStore", "./whoami", "./roster", "./passkey"]) delete require.cache[require.resolve(f)];
  M = { ...require("./whoami"), ...require("./roster"), ...require("./passkey") };
}

const ORIGIN = "http://localhost:5173";
const RPID = "localhost";
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

let clock = new Date("2026-11-10T03:00:00.000Z");
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

// ── กุญแจซอฟต์แวร์ (P-256 · attestation none) ────────────────────────────────
function softKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  const credId = crypto.randomBytes(16);
  let counter = 0;
  const rpHash = crypto.createHash("sha256").update(RPID).digest();
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const clientData = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin: origin || ORIGIN, crossOrigin: false }));
  return {
    id: credId.toString("base64url"),
    create(options, { uv = true } = {}) {
      const flags = 0x41 | (uv ? 0x04 : 0);
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), u32(counter), Buffer.alloc(16), len, credId, Buffer.from(cose)]);
      const att = isoCBOR.encode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return {
        id: credId.toString("base64url"), rawId: credId.toString("base64url"), type: "public-key", clientExtensionResults: {},
        response: { clientDataJSON: clientData("webauthn.create", options.challenge).toString("base64url"), attestationObject: Buffer.from(att).toString("base64url"), transports: ["internal"] },
      };
    },
    get(options, { uv = true, origin } = {}) {
      counter += 1;
      const authData = Buffer.concat([rpHash, Buffer.from([0x01 | (uv ? 0x04 : 0)]), u32(counter)]);
      const cd = clientData("webauthn.get", options.challenge, origin);
      const sig = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(cd).digest()]), privateKey);
      return {
        id: credId.toString("base64url"), rawId: credId.toString("base64url"), type: "public-key", clientExtensionResults: {},
        response: { clientDataJSON: cd.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: sig.toString("base64url") },
      };
    },
  };
}

async function enroll(uid, key, opts) {
  const o = await call("registerOptions", { origin: ORIGIN }, uid);
  assert.equal(o.code, 200, JSON.stringify(o.body));
  const v = await call("registerVerify", { origin: ORIGIN, attResp: key.create(o.body.options, opts), label: "MacBook" }, uid);
  return v;
}
async function assertion(uid, key, opts) {
  const o = await call("assertOptions", { origin: ORIGIN }, uid);
  assert.equal(o.code, 200, JSON.stringify(o.body));
  return { origin: ORIGIN, authResp: key.get(o.body.options, opts) };
}
const people = () => [{ uid: ROOT, name: "Root", level: "root" }, { uid: WATCH, name: "Watch", level: "watcher" }];

// ── ① พิธีของจริง ─────────────────────────────────────────────────────────
test("root ลงทะเบียนกุญแจใบแรก (แตะนิ้วครั้งเดียว) → เก็บ officePasskeys + audit · whoami เห็นกุญแจ", async () => {
  fresh(rosterSeed());
  const key = softKey();
  const v = await enroll(ROOT, key);
  assert.equal(v.code, 200, JSON.stringify(v.body));
  assert.equal(v.body.credentialId, key.id);
  const cred = mem.store.get(`officePasskeys/${key.id}`);
  assert.equal(cred.uid, ROOT);
  assert.equal(cred.rpID, RPID);
  assert.ok(!mem.store.has(`officePasskeyChallenges/${ROOT}`), "challenge ต้องถูกลบหลังใช้");
  assert.ok([...mem.store.keys()].some((k) => k.startsWith("officeAudit/") && mem.store.get(k).action === "passkey.register"));
  const w = await call("whoami", {}, ROOT);
  assert.equal(w.body.staffRole, "root");
  assert.equal(w.body.passkeys.length, 1);
  assert.equal(w.body.passkeyMax, 3);
});

test("ลงทะเบียนโดยไม่แตะนิ้ว (UV=0) → 403 enroll_failed ไม่เก็บกุญแจ", async () => {
  fresh(rosterSeed());
  const key = softKey();
  const v = await enroll(ROOT, key, { uv: false });
  assert.equal(v.code, 403);
  assert.equal(v.body.error, "enroll_failed");
  assert.ok(!mem.store.has(`officePasskeys/${key.id}`));
});

test("ยืนยันตัวผ่าน · ยิงลายเซ็นเดิมซ้ำ = 409 no_challenge (ใช้ครั้งเดียว) · counter เดินหน้า", async () => {
  fresh(rosterSeed());
  const key = softKey();
  await enroll(ROOT, key);
  const a = await assertion(ROOT, key);
  const ok1 = await call("assertVerify", a, ROOT);
  assert.equal(ok1.code, 200, JSON.stringify(ok1.body));
  assert.equal(mem.store.get(`officePasskeys/${key.id}`).counter, 1);
  const again = await call("assertVerify", a, ROOT);
  assert.equal(again.code, 409);
  assert.equal(again.body.error, "no_challenge");
});

test("ยืนยันตัวโดยไม่แตะนิ้ว (UV=0) → 403 assertion_failed (requireUserVerification)", async () => {
  fresh(rosterSeed());
  const key = softKey();
  await enroll(ROOT, key);
  const a = await assertion(ROOT, key, { uv: false });
  const r = await call("assertVerify", a, ROOT);
  assert.equal(r.code, 403);
  assert.equal(r.body.error, "assertion_failed");
});

test("challenge เก่ากว่า 5 นาที → 409 challenge_expired · origin นอกลิสต์ → 400 bad_origin", async () => {
  fresh(rosterSeed());
  const key = softKey();
  await enroll(ROOT, key);
  const a = await assertion(ROOT, key);
  clock = new Date(clock.getTime() + 5 * 60 * 1000 + 1000);
  try {
    const r = await call("assertVerify", a, ROOT);
    assert.equal(r.code, 409);
    assert.equal(r.body.error, "challenge_expired");
  } finally { clock = new Date("2026-11-10T03:00:00.000Z"); }
  const bad = await call("assertOptions", { origin: "https://evil.example" }, ROOT);
  assert.equal(bad.code, 400);
  assert.equal(bad.body.error, "bad_origin");
});

test("มีกุญแจแล้ว: เพิ่มใบที่ 2 โดยไม่แตะกุญแจเดิม = 409 enroll_needs_existing · แตะกุญแจเดิมแล้ว = ผ่าน", async () => {
  fresh(rosterSeed());
  const k1 = softKey();
  await enroll(ROOT, k1);
  const no = await call("registerOptions", { origin: ORIGIN }, ROOT);
  assert.equal(no.code, 409);
  assert.equal(no.body.error, "enroll_needs_existing");
  const a = await assertion(ROOT, k1);
  const k2 = softKey();
  const o = await call("registerOptions", { origin: ORIGIN, authResp: a.authResp }, ROOT);
  assert.equal(o.code, 200, JSON.stringify(o.body));
  const v = await call("registerVerify", { origin: ORIGIN, attResp: k2.create(o.body.options), label: "iPhone" }, ROOT);
  assert.equal(v.code, 200, JSON.stringify(v.body));
});

test("กุญแจของ root คนหนึ่ง ใช้ยืนยันตัวแทน root อีกคนไม่ได้ (credential_wrong_user)", async () => {
  const seed = rosterSeed();
  seed["watcher/roster"].rootUids = [ROOT, WATCH].sort();
  fresh(seed);
  const kRoot = softKey();
  await enroll(ROOT, kRoot);
  const kOther = softKey();
  await enroll(WATCH, kOther);
  const o = await call("assertOptions", { origin: ORIGIN }, WATCH);
  const r = await call("assertVerify", { origin: ORIGIN, authResp: kRoot.get(o.body.options) }, WATCH);
  assert.equal(r.code, 403);
  assert.equal(r.body.error, "credential_wrong_user");
});

// ── ② ทะเบียน ──────────────────────────────────────────────────────────────
test("root เพิ่ม watcher 1 คน + passkey → doc ทั้งชุด · log · audit · ตัวตัดสินทีมงานเห็นคนใหม่ทันที", async () => {
  fresh(rosterSeed());
  const key = softKey();
  await enroll(ROOT, key);
  const before = mem.store.get("watcher/roster").rosterSha;
  const r = await call("rosterSave", { people: [...people(), { uid: NEWBIE, name: "New", level: "watcher" }], expectCount: 3, baseRosterSha: before, passkey: await assertion(ROOT, key) }, ROOT);
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
  assert.equal(audit[1].passkeyCredentialId, key.id);
  // ดูผ่าน rosterGet ด้วย watcher (อ่านอย่างเดียว)
  const g = await call("rosterGet", {}, WATCH);
  assert.equal(g.code, 200);
  assert.equal(g.body.canEdit, false);
  assert.equal(g.body.count, 3);
});

test("ทะเบียนถูกแก้ระหว่างทาง (baseRosterSha ไม่ตรง) → 409 roster_changed ไม่เขียน · audit rejected", async () => {
  fresh(rosterSeed());
  const key = softKey();
  await enroll(ROOT, key);
  const r = await call("rosterSave", { people: people(), expectCount: 2, baseRosterSha: "b".repeat(64), passkey: await assertion(ROOT, key) }, ROOT);
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "roster_changed");
  assert.equal(mem.store.get("watcher/roster").via, "center-script");
  assert.ok([...mem.store.values()].some((v) => v && v.action === "watcher.roster.save" && v.result === "rejected" && v.rejectCode === "roster_changed"));
});

test("ถอดตัวเอง (รายชื่อว่าง + ติ๊กยืนยัน) → 200 · ไม่ติ๊ก → 400 empty_needs_confirm", async () => {
  fresh(rosterSeed());
  const key = softKey();
  await enroll(ROOT, key);
  const sha = mem.store.get("watcher/roster").rosterSha;
  const no = await call("rosterSave", { people: [], expectCount: 0, baseRosterSha: sha, passkey: await assertion(ROOT, key) }, ROOT);
  assert.equal(no.code, 400);
  assert.equal(no.body.error, "empty_needs_confirm");
  const r = await call("rosterSave", { people: [], expectCount: 0, allowEmpty: true, baseRosterSha: sha, passkey: await assertion(ROOT, key) }, ROOT);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(mem.store.get("watcher/roster").count, 0);
  assert.equal((await call("rosterGet", {}, ROOT)).body.error, "office_no_access");
});

test("uid ที่ไม่มีใน Firebase Auth → 422 uid_not_found ไม่เขียน", async () => {
  fresh(rosterSeed());
  const key = softKey();
  await enroll(ROOT, key);
  const sha = mem.store.get("watcher/roster").rosterSha;
  const r = await call("rosterSave", { people: [...people(), { uid: OUT, name: "?", level: "watcher" }], expectCount: 3, baseRosterSha: sha, passkey: await assertion(ROOT, key) }, ROOT);
  assert.equal(r.code, 422);
  assert.equal(r.body.error, "uid_not_found");
  assert.equal(mem.store.get("watcher/roster").count, 2);
});

test("บันทึกโดยลายเซ็นที่ใช้ไปแล้ว → 409 no_challenge (passkey ใบใหม่ทุกครั้ง)", async () => {
  fresh(rosterSeed());
  const key = softKey();
  await enroll(ROOT, key);
  const a = await assertion(ROOT, key);
  const sha = mem.store.get("watcher/roster").rosterSha;
  const first = await call("rosterSave", { people: people(), expectCount: 2, baseRosterSha: sha, passkey: a }, ROOT);
  assert.equal(first.code, 200, JSON.stringify(first.body));
  const again = await call("rosterSave", { people: people(), expectCount: 2, baseRosterSha: first.body.rosterSha, passkey: a }, ROOT);
  assert.equal(again.code, 409);
  assert.equal(again.body.error, "no_challenge");
});

test("ด่านคน: คนนอก whoami 200 none · rosterGet 403 office_no_access · watcher บันทึก 403 root_required · ทะเบียนไม่มี = ไม่มีใครเข้า", async () => {
  fresh(rosterSeed());
  const w = await call("whoami", {}, OUT);
  assert.equal(w.code, 200);
  assert.equal(w.body.staffRole, "none");
  assert.equal(w.body.canEdit, false);
  assert.equal(w.body.passkeys, undefined);
  assert.equal((await call("rosterGet", {}, OUT)).body.error, "office_no_access");
  assert.equal((await call("resolveEmail", { email: "new@shopchamp.test" }, WATCH)).body.error, "root_required");
  assert.equal((await call("assertOptions", { origin: ORIGIN }, WATCH)).body.error, "root_required");
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

test("เพิ่มกุญแจ: ตรรกะ decideEnroll (ศูนย์ใบ · เพดาน · นับไม่ได้)", () => {
  const C = require("./_officeCore");
  assert.deepEqual(C.decideEnroll({ count: 0, max: 3, hasAssertion: false }), { allow: true, code: null });
  assert.equal(C.decideEnroll({ count: 0, max: 3, hasAssertion: true }).code, "enroll_no_existing");
  assert.equal(C.decideEnroll({ count: 1, max: 3, hasAssertion: false }).code, "enroll_needs_existing");
  assert.equal(C.decideEnroll({ count: 3, max: 3, hasAssertion: true }).code, "passkey_cap_reached");
  assert.equal(C.decideEnroll({ count: undefined, max: 3 }).code, "bad_credential_count");
  assert.equal(C.challengeExpired(undefined, Date.now()), true);
});
