// เทส profile/loading.js · รัน: node --test functions/pos/profile/loading.test.js
//   ชุด case ของสัญญา (shopchamp-center/api/profile.loading.yaml) ไม่ได้คุมของในไฟล์นี้ (ผลตรวจอิสระ chunk4-verify/profile.loading.md)
//   ฐานปลอมในไฟล์นี้: บันทึกทุกการเขียน (harness ทำการเขียนเป็น no-op จึงพิสูจน์ "อ่านอย่างเดียว" ไม่ได้)
//   ❌ ไม่แตะ Firestore จริง: แทน functions/firebase ใน require.cache ก่อนโหลด handler
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime(), seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 }; };

let DATA = {};
let WRITES = [];
function makeDb() {
  const snapOf = (c, id) => { const d = (DATA[c] || {})[id]; return { exists: d !== undefined, id, data: () => d }; };
  const rec = (op, c, id) => (v) => { WRITES.push({ op, c, id, v }); };
  const ref = (c, id) => ({ id, get: async () => snapOf(c, id), set: rec("set", c, id), update: rec("update", c, id), delete: rec("delete", c, id) });
  return {
    collection: (c) => ({
      doc: (id) => ref(c, id),
      add: rec("add", c, null),
      where: (field, op, value) => {
        if (op !== "==") throw new Error(`where op ${op} ยังไม่รองรับ`);
        return {
          get: async () => {
            const ids = Object.keys(DATA[c] || {}).filter((id) => DATA[c][id] && DATA[c][id][field] === value);
            const docs = ids.map((id) => snapOf(c, id));
            return { empty: docs.length === 0, size: docs.length, docs };
          },
        };
      },
    }),
    runTransaction: async () => { WRITES.push({ op: "transaction" }); throw new Error("ไม่ควรเปิด transaction"); },
    batch: () => { WRITES.push({ op: "batch" }); throw new Error("ไม่ควรเขียน batch"); },
  };
}
const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: makeDb(), admin: {} } };
const L = require("./loading");
const { INITIAL_RIGHTS } = require("../_shared/auth");

const handler = L.loading({ now: () => NOW });
async function call(uid, body = { platform: "android" }) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ auth: uid ? { uid } : undefined, body }, res);
  return res;
}

const profile = (shopId) => ({ name: "x", tel: "0000000000", email: "a@example.com", imageId: "", currentLogin: { shopId, printer: [], rights: [] }, port: [{ shopId, printer: [] }] });
function shopDoc(x) {
  return {
    shopId: "shopA", name: "ร้านทดสอบ", receiptPattern: "month", POSs: [{ id: "pos-1" }],
    humanResource: [
      { id: "u-owner", name: "เจ้าของ", position: ["001"], status: "active", password: "1234" },
      { id: "u-staff", name: "พนักงาน", position: ["002"], status: "active", rights: ["116"], password: "9999" },
      { id: "u-company", name: "ทีมงาน", position: ["002"], status: "active", rights: ["116"], password: "5555" },
    ],
    vip: [{ type: "staff", expire: ts("2027-01-01T00:00:00.000Z") }, { type: "premium", expire: ts("2027-01-01T00:00:00.000Z") }],
    cutOff: ts("2026-01-01T17:00:00.000Z"),
    line: { channelAccessToken: "secret-token" },
    ...x,
  };
}
function seed(x = {}) {
  DATA = {
    profile: { "u-owner": profile("shopA"), "u-staff": profile("shopA"), "u-company": profile("shopA"), "u-watch": profile("shopA"), "u-old": profile("shopA") },
    shop: { shopA: shopDoc() },
    admin: {
      updateShopchamp: { android: { lastedVersion: "4.10.00", isMustUpdate: false, appUrl: "u", detail: "" } },
      adminConfig: { admin: ["u-company", "u-old"] },
    },
    // DEV-0001 watcher: u-company = root · u-watch = watcher · u-old อยู่แค่ adminConfig (ขาเก่า = ไม่ใช่ทีมงาน)
    watcher: { roster: { uids: ["u-company", "u-watch"], rootUids: ["u-company"] } },
    ...x,
  };
  WRITES = [];
}

// W1 · ทีมงานที่อยู่ใน humanResource ด้วย (ตำแหน่งพนักงาน) ต้องได้สิทธิ์เต็มแบบทีมงาน (LoadingScreen.js:83 · หัวสัญญาข้อ 3-2)
test("ทีมงานที่เป็นพนักงานในร้านด้วย → role owner · byAdmin · rights เต็มชุด", async () => {
  seed();
  const r = await call("u-company");
  assert.equal(r.code, 200);
  assert.equal(r.body.access.status, "active");
  assert.equal(r.body.access.role, "owner");
  assert.equal(r.body.access.byAdmin, true);
  assert.deepEqual(r.body.access.rights, [...INITIAL_RIGHTS]);
});

test("พนักงานธรรมดา (ไม่อยู่ในรายชื่อทีมงาน) → staff · rights ของตัวเอง · ไม่มี byAdmin", async () => {
  seed();
  const r = await call("u-staff");
  assert.deepEqual(r.body.access, { status: "active", role: "staff", rights: ["116"] });
});

test("ทีมงานที่เป็นพนักงานแต่แพ็กเกจ staff หมด → ยังได้สิทธิ์เต็ม", async () => {
  seed({ shop: { shopA: shopDoc({ vip: [{ type: "staff", expire: ts("2026-01-01T00:00:00.000Z") }] }) } });
  const r = await call("u-company");
  assert.equal(r.body.access.byAdmin, true);
  assert.deepEqual(r.body.access.rights, [...INITIAL_RIGHTS]);
});

test("ทีมงานที่ไม่อยู่ในร้าน → rights เต็มชุด (ไม่ใช่ว่าง)", async () => {
  seed({ shop: { shopA: shopDoc({ humanResource: [{ id: "u-owner", position: ["001"], status: "active" }] }) } });
  const r = await call("u-company");
  assert.equal(r.body.access.byAdmin, true);
  assert.deepEqual(r.body.access.rights, [...INITIAL_RIGHTS]);
});

// G5
test("เจ้าของ → rights = initialRights ทั้งชุด", async () => {
  seed();
  const r = await call("u-owner");
  assert.deepEqual(r.body.access, { status: "active", role: "owner", rights: [...INITIAL_RIGHTS] });
});

// G4
test("staff[] ไม่มี password และ rights ของใคร · มีแค่ช่องที่อนุญาต", async () => {
  seed();
  const r = await call("u-owner");
  assert.equal(r.body.shop.staff.length, 3);
  for (const s of r.body.shop.staff) {
    assert.equal(s.password, undefined);
    assert.equal(s.rights, undefined);
    for (const k of Object.keys(s)) assert.ok(L.STAFF_FIELDS.includes(k), `ช่อง ${k} ไม่ควรออก`);
  }
  assert.equal(JSON.stringify(r.body).includes("9999"), false);
  assert.equal(JSON.stringify(r.body).includes("secret-token"), false);
});

// G1 ส่วน fail-closed · ช่องที่ไม่อยู่ใน allowlist ไม่ออก (ช่องใหม่ที่เพิ่มในฐานพรุ่งนี้)
test("ช่องร้านที่ไม่อยู่ใน allowlist ไม่ออก", async () => {
  seed({ shop: { shopA: shopDoc({ brandNewSecret: "zzz", taxCustomer: [{ id: 1 }] }) } });
  const r = await call("u-owner");
  assert.equal(r.body.shop.brandNewSecret, undefined);
  assert.equal(r.body.shop.taxCustomer, undefined);
  const allowed = new Set([...L.SHOP_FIELDS, "id", "staff"]);
  for (const k of Object.keys(r.body.shop)) assert.ok(allowed.has(k), `ช่อง ${k} ไม่อยู่ใน allowlist`);
});

// G6 · หลาย doc shopId เดียวกัน = ใช้ตัวสุดท้าย (LoadingScreen.js:66-68)
test("ร้านซ้ำ shopId เดียวกัน 2 doc → ใช้ doc ตัวสุดท้าย", async () => {
  seed({ shop: { docFirst: shopDoc({ name: "ตัวแรก" }), docLast: shopDoc({ name: "ตัวสุดท้าย" }) } });
  const r = await call("u-owner");
  assert.equal(r.body.shop.id, "docLast");
  assert.equal(r.body.shop.name, "ตัวสุดท้าย");
});

// G7
test("ช่องเวลาแปลงเป็นข้อความ ISO (vip[].expire · cutOff · port)", async () => {
  seed({ profile: { "u-owner": { ...profile("shopA"), port: [{ shopId: "shopA", at: ts("2026-05-05T05:05:05.000Z") }] } } });
  const r = await call("u-owner");
  assert.equal(r.body.shop.vip[0].expire, "2027-01-01T00:00:00.000Z");
  assert.equal(r.body.shop.vip[1].expire, "2027-01-01T00:00:00.000Z");
  assert.equal(r.body.shop.cutOff, "2026-01-01T17:00:00.000Z");
  assert.equal(r.body.profile.port[0].at, "2026-05-05T05:05:05.000Z");
});

// G8 · อ่านอย่างเดียวทุกทาง
test("ไม่เขียนฐานเลยทุกทาง (เจ้าของ · พนักงาน · ทีมงาน · ไม่มีร้าน · ไม่ใช่สมาชิก)", async () => {
  seed();
  DATA.profile["u-none"] = profile("");
  DATA.profile["u-x"] = profile("shopA");
  for (const uid of ["u-owner", "u-staff", "u-company", "u-none", "u-x"]) await call(uid);
  assert.deepEqual(WRITES, []);
});

test("profile ที่คืน = 5 ช่องเท่านั้น (ไม่คืน currentLogin หรือ doc ทั้งก้อน)", async () => {
  seed({ profile: { "u-owner": { ...profile("shopA"), secretX: "s", currentLogin: { shopId: "shopA", rights: ["x"] } } } });
  const r = await call("u-owner");
  assert.deepEqual(Object.keys(r.body.profile).sort(), ["email", "imageId", "name", "port", "tel"]);
});

// ── chunk4 รอบ 2 (Pack เคาะ 2026-11-06 · A-2 A-3 · agent เลือก B-2 B-3) ──
test("A-2 ช่องร้านที่แอปเก่าอ่านออกครบ · lineNoti lineUsers line taxCustomer ไม่ออก", async () => {
  seed({ shop: { shopA: shopDoc({ smartCoupon: [{ id: "c1" }], notiShift: ["p1"], receiptPay: { status: false }, totalMember: 3,
    lineNoti: { shift: ["U1"] }, lineUsers: [{ id: "U1" }], taxCustomer: [{ taxId: "x" }] }) } });
  const r = await call("u-owner");
  assert.deepEqual(r.body.shop.smartCoupon, [{ id: "c1" }]);
  assert.deepEqual(r.body.shop.notiShift, ["p1"]);
  assert.deepEqual(r.body.shop.receiptPay, { status: false });
  assert.equal(r.body.shop.totalMember, 3);
  for (const k of ["lineNoti", "lineUsers", "line", "taxCustomer", "humanResource"]) assert.equal(k in r.body.shop, false, k);
});

test("A-3 update.isPackageOn ออกเมื่อมี · ไม่มีก็ไม่เติม", async () => {
  seed();
  DATA.admin.updateShopchamp.android.isPackageOn = true;
  assert.equal((await call("u-owner")).body.update.isPackageOn, true);
  delete DATA.admin.updateShopchamp.android.isPackageOn;
  assert.equal("isPackageOn" in (await call("u-owner")).body.update, false);
});

test("B-2 ไม่มี admin/updateShopchamp → update:null แต่ยัง 200 active", async () => {
  seed();
  delete DATA.admin.updateShopchamp;
  const r = await call("u-owner");
  assert.equal(r.code, 200);
  assert.equal(r.body.update, null);
  assert.equal(r.body.access.status, "active");
});

test("B-3 adminConfig ออกแค่ mainAds screenVedios · รายชื่อ admin ไม่ออกทุกสถานะ · ไม่มี doc = ไม่มี key", async () => {
  seed();
  DATA.admin.adminConfig = { admin: ["u-company"], mainAds: [{ id: "a1" }], screenVedios: { HomeScreen: "v" }, secret: "x" };
  for (const uid of ["u-owner", "u-company", "u-staff"]) {
    const r = await call(uid);
    assert.deepEqual(r.body.adminConfig, { mainAds: [{ id: "a1" }], screenVedios: { HomeScreen: "v" } }, uid);
    assert.equal(JSON.stringify(r.body).includes("u-company\"]"), false);
  }
  DATA.profile["u-owner"] = profile("");
  assert.deepEqual((await call("u-owner")).body.adminConfig.mainAds, [{ id: "a1" }]); // no_shop ก็ได้โฆษณา (แอปเก่าโหลดทุกกรณี)
  delete DATA.admin.adminConfig;
  seed(); delete DATA.admin.adminConfig;
  const r = await call("u-owner");
  assert.equal("adminConfig" in r.body, false);
  assert.equal(r.body.access.status, "active"); // ไม่มี doc = ไม่มีทีมงาน แต่เจ้าของยังเข้าได้
});

// ── DEV-0001 watcher (Pack เคาะ 2026-11-07 ข้อ 9: แอปใหม่ใช้ธงจาก server) ──
test("staffRole: root / watcher / none ทุกบัญชีที่มี profile · ขาเก่า (อยู่แค่ adminConfig) = none", async () => {
  seed();
  assert.equal((await call("u-company")).body.staffRole, "root");
  assert.equal((await call("u-watch")).body.staffRole, "watcher");
  assert.equal((await call("u-owner")).body.staffRole, "none");
  const old = await call("u-old");
  assert.equal(old.body.staffRole, "none");
  assert.equal(old.body.access.status, "not_a_member");
});

test("watcher ไม่อยู่ในร้าน → active owner สิทธิ์เต็ม + watcher + readOnly · ไม่มี byAdmin · root ได้ byAdmin + root", async () => {
  seed();
  const w = await call("u-watch");
  assert.deepEqual(w.body.access, { status: "active", role: "owner", rights: [...INITIAL_RIGHTS], watcher: true, readOnly: true });
  const r = await call("u-company");
  assert.equal(r.body.access.root, true);
  assert.equal(r.body.access.byAdmin, true);
  assert.equal(r.body.access.readOnly, undefined);
});

test("ทะเบียนไม่มี/ว่าง → ไม่มีใครเป็นทีมงาน (fail-closed)", async () => {
  for (const roster of [undefined, { uids: [] }, { uids: "u-company" }]) {
    seed(roster === undefined ? {} : { watcher: { roster } });
    if (roster === undefined) delete DATA.watcher;
    const r = await call("u-company");
    assert.equal(r.body.staffRole, "none", JSON.stringify(roster));
    assert.equal(r.body.access.byAdmin, undefined);
    assert.equal(r.body.access.role, "staff"); // u-company เป็นพนักงานของร้าน · ได้สิทธิ์ตามแถวตัวเอง
  }
});

test("จอลูกค้าวิดีโอ (DEV-0001 · 2026-11-08): customerAdsVideo customerAdsMode ออกในก้อน shop แบบ customerAds · ไม่มีในฐาน = ไม่มี key", async () => {
  seed({ shop: { shopA: shopDoc({ customerAds: ["https://img.example.com/a.png"], customerAdsVideo: ["https://v.example.com/a.mp4"], customerAdsMode: "video" }) } });
  const r = await call("u-owner");
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.shop.customerAds, ["https://img.example.com/a.png"]);
  assert.deepEqual(r.body.shop.customerAdsVideo, ["https://v.example.com/a.mp4"]);
  assert.equal(r.body.shop.customerAdsMode, "video");
  seed();
  const r2 = await call("u-owner");
  assert.equal("customerAdsVideo" in r2.body.shop, false);
  assert.equal("customerAdsMode" in r2.body.shop, false);
});
