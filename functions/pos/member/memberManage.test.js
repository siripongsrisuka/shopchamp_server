// เทส member/{create,update,redeemPoint,delete,rebuildIndex}.js (ก้อน 9b) · รัน: node --test functions/pos/member/memberManage.test.js
//   harness ของสัญญาวัดคำตอบและการเขียนต่อ 1 คำขอ (เขียนไม่ลงฐาน) ⇒ ลำดับหลายคำขอ ส่งซ้ำ อ่านหลังเขียน พิสูจน์ที่นี่
//   ฐานปลอม `_fakeDb.js`: เขียนลงจริงตอน commit · อ่านหลังเขียนใน transaction = throw · update doc ที่ไม่มี = throw
//   ❌ ไม่แตะ Firestore จริง
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { installFakeDb } = require("./_fakeDb");

const F = installFakeDb(path, {});
const { create } = require("./create");
const { update } = require("./update");
const { redeemPoint } = require("./redeemPoint");
const { del } = require("./delete");
const { rebuildIndex } = require("./rebuildIndex");
const logic = require("@shopchamp/logic");
const { Member, MemberListWrite, PointHistory } = require("@shopchamp/schema");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const deps = { now: () => NOW };
const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
const STAFF = (rights) => ({ shopId: "shopA", uid: "u-staff", role: "staff", rights });
const U1 = "5f0c6a8e-1d2b-4c3a-9e7f-000000000001";
const U2 = "5f0c6a8e-1d2b-4c3a-9e7f-000000000002";
const R1 = "7a1e2b3c-4d5e-4f60-8a9b-000000000002";
const R2 = "7a1e2b3c-4d5e-4f60-8a9b-000000000003";
const FUTURE = new Date("2027-12-31T00:00:00.000Z");

function shopSeed(extra = {}) {
  return {
    shopA: {
      shopId: "shopA", totalMember: 0, vip: [{ type: "staff", expire: FUTURE }],
      humanResource: [
        { id: "u-owner", position: ["001"], status: "active" },
        { id: "u-staff", position: ["002"], status: "active", rights: ["124", "125", "126"] },
      ],
      ...extra,
    },
  };
}
async function call(h, body, access = OWNER) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await h(deps)({ body, shopAccess: access }, res);
  return res;
}
const createBody = (o = {}) => ({ shopId: "shopA", memberUUID: U1, name: "สมชาย", tel: "0899999999", point: 0, credit: 0, ...o });

test("create: doc ที่เขียนผ่าน schema อ่าน Member · ดัชนีผ่าน MemberListWrite · ตัวนับ 1", async () => {
  F.reset({ shop: shopSeed() });
  const r = await call(create, createBody());
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const m = F.data.member[U1];
  assert.equal(Member.safeParse(m).success, true);
  const letter = logic.letterForMemberId(U1);
  assert.equal(m.letter, letter);
  const list = F.data.memberList[letter + "shopA"];
  assert.equal(MemberListWrite.safeParse(list).success, true, JSON.stringify(MemberListWrite.safeParse(list).error));
  assert.equal(F.data.shop.shopA.totalMember, 1);
});

test("create: ส่งซ้ำ memberUUID เดิม 2 ครั้ง ⇒ สมาชิก 1 คน แถวดัชนี 1 แถว ตัวนับ 1 (F23)", async () => {
  F.reset({ shop: shopSeed() });
  const a = await call(create, createBody());
  const b = await call(create, createBody());
  assert.equal(a.body.duplicate, false);
  assert.equal(b.body.duplicate, true);
  assert.equal(Object.keys(F.data.member).length, 1);
  const list = F.data.memberList[logic.letterForMemberId(U1) + "shopA"];
  assert.equal(list.members.length, 1);
  assert.equal(F.data.shop.shopA.totalMember, 1);
});

test("create: 2 คนคนละ uuid ⇒ ตัวนับ 2 · เพดาน 50 นับจากจำนวนจริง ไม่ใช่ตัวนับเพี้ยน (F58 · K20)", async () => {
  const members = {};
  for (let i = 0; i < 49; i++) members[`f${i}`] = { shopId: "shopA", name: "x", tel: "1" };
  F.reset({ shop: shopSeed({ totalMember: 999 }), member: members });
  assert.equal((await call(create, createBody())).code, 200);
  assert.equal(F.data.shop.shopA.totalMember, 50);
  const r = await call(create, createBody({ memberUUID: U2 }));
  assert.equal(r.code, 409);
  assert.equal(r.body.error, "member_limit");
});

test("redeemPoint: ตัด 80 สองครั้งจาก 100 ⇒ ครั้งที่ 2 ปัด point_insufficient แต้มไม่ติดลบ (F11 ตัวอย่างในไฟล์บั๊ก)", async () => {
  F.reset({ shop: shopSeed(), member: { m1: { shopId: "shopA", point: 100 } } });
  const body = { shopId: "shopA", memberId: "m1", points: 80, requestId: R1, staffId: "u-owner", staffName: "" };
  assert.equal((await call(redeemPoint, body)).body.pointAfter, 20);
  const second = await call(redeemPoint, { ...body, requestId: R2 });
  assert.equal(second.code, 409);
  assert.equal(second.body.error, "point_insufficient");
  assert.equal(F.data.member.m1.point, 20);
  assert.equal(PointHistory.safeParse(F.data.pointHistory[R1]).success, true);
  assert.equal(F.data.pointHistory[R2], undefined);
});

test("redeemPoint: กดซ้ำ requestId เดิม ⇒ ตัดครั้งเดียว ผลเดิม", async () => {
  F.reset({ shop: shopSeed(), member: { m1: { shopId: "shopA", point: 100 } } });
  const body = { shopId: "shopA", memberId: "m1", points: 30, requestId: R1, staffId: "u-owner", staffName: "" };
  const a = await call(redeemPoint, body);
  const b = await call(redeemPoint, body);
  assert.equal(a.body.pointAfter, 70);
  assert.equal(b.body.duplicate, true);
  assert.equal(b.body.pointAfter, 70);
  assert.equal(F.data.member.m1.point, 70);
});

test("update → delete → delete ซ้ำ: ดัชนีตามทุกขั้น · ลบซ้ำ 404 ไม่ลดตัวนับ (F28 · F58)", async () => {
  F.reset({ shop: shopSeed({ totalMember: 2 }) });
  await call(create, createBody());
  await call(create, createBody({ memberUUID: U2, name: "สมหญิง" }));
  const L1 = logic.letterForMemberId(U1);
  const up = await call(update, { shopId: "shopA", memberId: U1, name: "ชื่อใหม่", tel: "0800000000" }, STAFF(["126"]));
  assert.equal(up.code, 200);
  assert.deepEqual(F.data.memberList[L1 + "shopA"].members.find((r) => r.id === U1), { id: U1, name: "ชื่อใหม่", tel: "0800000000" });
  const d1 = await call(del, { shopId: "shopA", memberId: U1 });
  assert.equal(d1.code, 200);
  assert.equal(F.data.shop.shopA.totalMember, 1);
  assert.equal(F.data.member[U1], undefined);
  assert.equal(F.data.memberList[L1 + "shopA"].members.some((r) => r.id === U1), false);
  const d2 = await call(del, { shopId: "shopA", memberId: U1 });
  assert.equal(d2.code, 404);
  assert.equal(F.data.shop.shopA.totalMember, 1);
});

test("rebuildIndex: ทุกคนค้นเจอ · letter เดิมคงไว้ · เรียกซ้ำได้ผลเดิม · แถวที่เพิ่งเพิ่มไม่หาย (F24 F26 F27)", async () => {
  const members = { k1: { shopId: "shopA", name: "เก่า1", tel: "1", letter: "C" }, k2: { shopId: "shopA", name: "เก่า2", tel: "2" }, k3: { shopId: "shopA" } };
  F.reset({ shop: shopSeed(), member: members, memberList: { CshopA: { shopId: "shopA", members: [{ id: "late", name: "มาทีหลัง", tel: "9" }] } } });
  // late = สมาชิกที่เพิ่มหลัง query (query ไม่เห็น · อ่านรายตัวเจอ) · ไม่มี doc member เลย = แถวผี ถูกล้าง (ดูเทส ผ2 ด้านล่าง)
  Object.defineProperty(F.data.member, "late", { value: { shopId: "shopA", name: "มาทีหลัง", tel: "9", letter: "C" }, enumerable: false });
  const r1 = await call(rebuildIndex, { shopId: "shopA" }, STAFF([]));
  assert.equal(r1.code, 200, JSON.stringify(r1.body));
  assert.equal(F.data.member.k1.letter, "C");
  for (const id of ["k1", "k2", "k3"]) {
    const L = F.data.member[id].letter;
    assert.ok(logic.isMemberLetter(L));
    assert.ok(F.data.memberList[L + "shopA"].members.some((x) => x.id === id), `ค้น ${id} ไม่เจอ`);
  }
  assert.ok(F.data.memberList.CshopA.members.some((x) => x.id === "late"), "แถวที่ไม่อยู่ในผลอ่านต้องไม่หาย");
  const snapshot = JSON.stringify(F.data.memberList);
  const r2 = await call(rebuildIndex, { shopId: "shopA" });
  assert.equal(r2.body.lettersAssigned, 0);
  assert.equal(JSON.stringify(F.data.memberList).replace(/updateTime/g, ""), snapshot.replace(/updateTime/g, ""));
});

test("rebuildIndex: สมาชิก 901 คนไม่มี letter ⇒ batch แบ่งก้อนไม่เกิน 500 (F25)", async () => {
  const members = {};
  for (let i = 0; i < 901; i++) members[`z${i}`] = { shopId: "shopA", name: `n${i}`, tel: "0" };
  F.reset({ shop: shopSeed(), member: members });
  const r = await call(rebuildIndex, { shopId: "shopA" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.lettersAssigned, 901);
  const total = Object.values(F.data.memberList).reduce((n, d) => n + d.members.length, 0);
  assert.equal(total, 901);
});

test("พนักงานที่ถูกปิดสถานะหลังได้ token ⇒ 403 ทุก route ของโดเมนนี้ (B-11 ด่านซ้ำใน transaction)", async () => {
  const off = { shopId: "shopA", uid: "u-off", role: "staff", rights: ["124", "125", "126"] };
  const seed = () => ({ shop: shopSeed({ humanResource: [{ id: "u-owner", position: ["001"], status: "active" }, { id: "u-off", position: ["002"], status: "inActive" }] }), member: { m1: { shopId: "shopA", point: 10, letter: "A" } } });
  for (const [h, body] of [
    [create, createBody()],
    [update, { shopId: "shopA", memberId: "m1", name: "a", tel: "1" }],
    [redeemPoint, { shopId: "shopA", memberId: "m1", points: 1, requestId: R1, staffId: "u-off", staffName: "" }],
    [del, { shopId: "shopA", memberId: "m1" }],
    [rebuildIndex, { shopId: "shopA" }],
  ]) {
    F.reset(seed());
    const r = await call(h, body, off);
    assert.equal(r.code, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "not_shop_member");
    assert.equal(F.log.length, 0);
  }
});

// ───────── แก้ตามผลตรวจอิสระ 9b (2026-11-06 · lanes/dev/source/chunk9/9b-member-product.verify.md) ─────────
const ADMIN = { shopId: "shopA", uid: "u-company", role: "owner", rights: [], byAdmin: true };

test("ผ2 rebuildIndex: เอาแถวซ้ำข้ามตัวอักษรและแถวของสมาชิกที่ถูกลบออก · แถวของสมาชิกที่มีอยู่จริงในตัวอักษรนั้นไม่หาย (F26 F13 · F27)", async () => {
  F.reset({
    shop: shopSeed(),
    member: { m1: { name: "a", tel: "1", shopId: "shopA", letter: "B" } },
    memberList: {
      AshopA: { shopId: "shopA", members: [{ id: "m1", name: "a", tel: "1" }, { id: "ghost", name: "ลบแล้ว", tel: "9" }, { id: "late", name: "มาทีหลัง", tel: "9" }], updateTime: new Date("2026-11-01T00:00:00Z") },
      BshopA: { shopId: "shopA", members: [{ id: "m1", name: "a", tel: "1" }], updateTime: new Date("2026-11-01T00:00:00Z") },
      ZshopB: { shopId: "shopB", members: [{ id: "x", name: "ร้านอื่น", tel: "0" }], updateTime: new Date("2026-11-01T00:00:00Z") },
    },
  });
  // late อยู่ในฐานแต่ query สมาชิกไม่เห็น (จำลองสมาชิกที่แอปเก่าเพิ่มหลังอ่าน) · property ที่ไม่ enumerable = query ข้าม · อ่านรายตัวเจอ
  Object.defineProperty(F.data.member, "late", { value: { name: "มาทีหลัง", tel: "9", shopId: "shopA", letter: "A" }, enumerable: false });
  const r = await call(rebuildIndex, { shopId: "shopA" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(F.data.memberList.AshopA.members.map((x) => x.id), ["late"]);
  assert.deepEqual(F.data.memberList.BshopA.members.map((x) => x.id), ["m1"]);
  assert.equal(F.data.memberList.AshopA.updateTime.getTime(), NOW.getTime(), "doc ที่ล้างแถวต้องได้ updateTime ใหม่ให้จอขายดึงใหม่");
  assert.deepEqual(F.data.memberList.ZshopB.members.map((x) => x.id), ["x"], "ไม่แตะดัชนีของร้านอื่น");
});

test("ผ2 rebuildIndex: doc ดัชนีที่ทุกแถวเป็นผี ⇒ set members [] (ไม่ลบ doc · แอปเก่าแทนของในเครื่องด้วย doc ที่ดึงได้)", async () => {
  F.reset({ shop: shopSeed(), member: {}, memberList: { QshopA: { shopId: "shopA", members: [{ id: "ghost", name: "ลบแล้ว", tel: "9" }], updateTime: new Date("2026-11-01T00:00:00Z") } } });
  const r = await call(rebuildIndex, { shopId: "shopA" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(F.data.memberList.QshopA.members, []);
});

test("ผ3 ทีมงานแก้ชื่อ/ตัดแต้ม ⇒ member มี byAdmin adminUid · เจ้าของแก้ต่อ ⇒ ล้างเป็น byAdmin false adminUid null", async () => {
  F.reset({ shop: shopSeed(), member: { m1: { name: "a", tel: "1", shopId: "shopA", letter: "B", point: 100 } } });
  assert.equal((await call(update, { shopId: "shopA", memberId: "m1", name: "b", tel: "2" }, ADMIN)).code, 200);
  assert.equal(F.data.member.m1.byAdmin, true);
  assert.equal(F.data.member.m1.adminUid, "u-company");
  assert.equal((await call(update, { shopId: "shopA", memberId: "m1", name: "c", tel: "2" })).code, 200);
  assert.equal(F.data.member.m1.byAdmin, false);
  assert.equal(F.data.member.m1.adminUid, null);
  const rr = await call(redeemPoint, { shopId: "shopA", memberId: "m1", points: 1, requestId: R1, staffId: "u-company", staffName: "ทีมงาน" }, ADMIN);
  assert.equal(rr.code, 200, JSON.stringify(rr.body));
  assert.equal(F.data.member.m1.byAdmin, true);
  assert.equal(F.data.member.m1.adminUid, "u-company");
});

test("ผ3 คนในร้านแก้สมาชิกที่ไม่เคยมีรอยทีมงาน ⇒ ไม่เติม byAdmin (เพิ่ม field เฉพาะเมื่อจำเป็น)", async () => {
  F.reset({ shop: shopSeed(), member: { m1: { name: "a", tel: "1", shopId: "shopA", letter: "B", point: 100 } } });
  assert.equal((await call(update, { shopId: "shopA", memberId: "m1", name: "b", tel: "2" })).code, 200);
  assert.equal("byAdmin" in F.data.member.m1, false);
});

test("ผ4 ร้าน S5 ที่พิสูจน์ field ไม่ได้ (field ใช้ร่วม 2 ร้าน): เพดานนับจากตัวนับเดิมด้วย · ตัวนับไม่ถูกเขียนลด", async () => {
  const members = {};
  for (let i = 0; i < 60; i++) members["old" + i] = { name: "n", tel: "t", shopId: "uidOwner", letter: "C", point: 0 };
  const hr = [{ id: "u-owner", position: ["001"], status: "active" }];
  F.reset({ shop: { shopX: { shopId: "uidOwner", vip: [], totalMember: 60, humanResource: hr }, shopY: { shopId: "uidOwner", vip: [], humanResource: hr } }, member: members });
  const X = { shopId: "shopX", uid: "u-owner", role: "owner", rights: [] };
  const r = await call(create, { ...createBody(), shopId: "shopX" }, X);
  assert.equal(r.code, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, "member_limit");
  assert.equal(F.data.shop.shopX.totalMember, 60);
  // มีแพ็กเกจสมาชิก ⇒ สร้างได้ · ตัวนับ = ตัวนับเดิม + 1 (ไม่ใช่ 1)
  F.data.shop.shopX.vip = [{ type: "member", expire: FUTURE }];
  const ok = await call(create, { ...createBody(), shopId: "shopX" }, X);
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(F.data.shop.shopX.totalMember, 61);
  // ลบสมาชิกที่สร้าง ⇒ ตัวนับ − 1 จากค่าเดิม (ไม่ใช่จำนวน doc id ที่นับได้ − 1 = 0)
  const d = await call(del, { shopId: "shopX", memberId: U1 }, X);
  assert.equal(d.code, 200, JSON.stringify(d.body));
  assert.equal(F.data.shop.shopX.totalMember, 60);
});
