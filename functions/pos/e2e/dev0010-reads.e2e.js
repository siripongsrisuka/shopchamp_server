// pos/e2e/dev0010-reads.e2e.js — query ใหม่ของ DEV-0010 บน Firestore emulator (ของที่ฐานปลอมพิสูจน์ไม่ได้)
//   ฐานปลอม (harness · *.test.js) เรียง/ตัดหน้าเองในโค้ด ⇒ ไม่รู้ว่า Firestore จริงรับ query รูปนี้ไหม · ที่นี่ใช้ where/orderBy/startAfter/limit ของ emulator จริง
//   ① stock.sync: orderBy updateTime, __name__ + startAfter(Timestamp, id) · เวลาต่างกันระดับไมโครวินาที (ms เดียวกัน) · doc เวลาเท่ากันข้ามหน้า
//   ② member.indexSync: shopId in [ช่อง, doc id] (ร้านรุ่นแรก 2 คีย์) + orderBy updateTime, __name__ + startAfter
//   ③ report.billList: หลายหน้า orderBy dateTime desc, __name__ desc + startAfter(at, id) · บิลเวลาเท่ากันข้ามหน้า · ร้านรุ่นแรก 2 คีย์รวมกัน
//   ไล่ทุกหน้าจนจบ แล้วเทียบกับคำตอบที่คิดเองจาก seed: ครบ · ไม่ซ้ำ · เรียงถูก · ร้านอื่นไม่ปน · ไม่เขียนอะไร
//   คู่เทียบ 2 ทิศ (รัน 2026-11-14): ตัด startAfter ใน _shared/syncCursor.js = ①② แดง · cursor ปัดเป็น ms = ①② แดง · billList byId:false = ③ แดง
//   ⚠️ emulator ไม่บังคับ composite index ⇒ index ตรวจจาก shopchamp_server/firestore.indexes.json แยก (มีครบ 3 ตัว · ดูหัวสัญญา)
// รัน: cd functions && node pos/e2e/run.js pos/e2e/dev0010-reads.e2e.js
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const E = require("./_env");
const { sync } = require("../stock/syncRead");
const { indexSync } = require("../member/read");
const { billList } = require("../report/billList");

const { call, seed, clock, T, ns, dump, Timestamp } = E;
const NOW = clock("2026-11-12T03:00:00.000Z");
const SEC = 1793000000; // 2026-10-26 · วินาทีเดียวกันทุก doc · ต่างกันที่ nanos (ระดับไมโครวินาที = ms เดียวกัน)
const TS = (micros) => new Timestamp(SEC, 100000000 + micros * 1000);

before(() => E.ready());

/** ไล่ทุกหน้า · กันวนไม่จบด้วยเพดานรอบ */
async function allPages(fetchPage, max = 50) {
  const pages = [];
  let cursor;
  for (let i = 0; i < max; i++) {
    const r = await fetchPage(cursor);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    pages.push(r.body);
    const next = r.body.nextCursor;
    if (!(r.body.hasMore === true || (r.body.hasMore === undefined && next))) return pages;
    assert.ok(next, "มีหน้าต่อแต่ไม่มี cursor");
    cursor = next;
  }
  throw new Error("ไล่หน้าเกินเพดาน (cursor ไม่เดิน)");
}

test("stock.sync: หลายหน้าบน emulator · cursor เวลาไมโครวินาที + doc id · doc เวลาเท่ากันข้ามหน้าไม่หาย/ไม่ซ้ำ · ลบไปอยู่ deletedIds · ร้านอื่นไม่ปน", async () => {
  const n = ns();
  const A = `shopA${n}`, B = `shopB${n}`;
  const st = (shopId, updateTime, x) => ({ shopId, name: "ของ", stock: 1, cost: 1, price: 2, updateTime, createdBy: "u", ...x });
  // ลำดับที่ถูก (เวลา, id): a1 a2 a3 (µs 0) · b1 b2 d1 (µs 1) · c1 (µs 2)
  await seed({
    shop: { [A]: { shopId: A, name: "ร้านเอ" }, [B]: { shopId: B, name: "ร้านบี" } },
    stock: {
      [`a3${n}`]: st(A, TS(0)), [`a1${n}`]: st(A, TS(0)), [`a2${n}`]: st(A, TS(0)),
      [`b2${n}`]: st(A, TS(1)), [`b1${n}`]: st(A, TS(1)), [`d1${n}`]: st(A, TS(1), { sku: "delete" }),
      [`c1${n}`]: st(A, TS(2)),
      [`x1${n}`]: st(B, TS(0)), // ร้านอื่น เวลาเดียวกัน
      [`old${n}`]: st(A, T("2010-12-31T16:00:00.000Z")), // ก่อน FLOOR ของแอปเดิม = ไม่มา
      [`none${n}`]: { shopId: A, name: "ไม่มีเวลา" },
    },
  });
  const before0 = await dump();
  const access = { shopId: A, uid: `u${n}`, role: "staff", rights: [] };
  const pages = await allPages((cursor) => call(sync, NOW, { body: { shopId: A, limit: 2, ...(cursor ? { cursor } : {}) }, shopAccess: access }));
  const seen = pages.flatMap((p) => [...p.items.map((i) => i.id), ...p.deletedIds]);
  const order = ["a1", "a2", "a3", "b1", "b2", "d1", "c1"].map((x) => `${x}${n}`);
  // ในหน้าเดียวกัน items กับ deletedIds แยกกัน ⇒ เทียบชุดของแต่ละหน้าตามลำดับหน้า
  assert.deepEqual(pages.map((p) => [...p.items.map((i) => i.id), ...p.deletedIds].sort()), [[order[0], order[1]], [order[2], order[3]], [order[4], order[5]].sort(), [order[6]]]);
  assert.equal(new Set(seen).size, seen.length, "ไม่ซ้ำ");
  assert.deepEqual([...seen].sort(), [...order].sort(), "ครบ ไม่มีร้านอื่น ไม่มีของก่อน FLOOR/ไม่มีเวลา");
  assert.deepEqual(pages.flatMap((p) => p.deletedIds), [`d1${n}`]);
  // cursor ของหน้าที่ 2 จบที่ b1 (µs 1) ⇒ เก็บ nanos 100001000 ไม่ปัดเป็น ms (ถ้าปัด b2 ที่ ms เดียวกันจะหาย/ซ้ำ)
  assert.equal(pages[1].nextCursor, `1|${SEC}|100001000|b1${n}`);
  assert.equal(pages[0].items[0].createdBy, undefined, "ตัดรอยทีมงาน");
  assert.equal(pages[0].items[0].updateTime, new Date(SEC * 1000 + 100).toISOString());
  // หน้าสุดท้าย: ส่ง cursor สุดท้ายซ้ำ = ว่าง · cursor เดิม · ไม่มีหน้าต่อ
  const last = pages[pages.length - 1];
  const again = await call(sync, NOW, { body: { shopId: A, limit: 2, cursor: last.nextCursor }, shopAccess: access });
  assert.deepEqual([again.body.items, again.body.deletedIds, again.body.nextCursor, again.body.hasMore], [[], [], last.nextCursor, false]);
  assert.deepEqual(await dump(), before0, "ไม่เขียนอะไร");
  // มีของเปลี่ยนหลังจากนั้น (เวลาใหม่กว่า) = รอบถัดไปได้แค่ตัวนั้น
  await E.db.collection("stock").doc(`a2${n}`).update({ updateTime: TS(5), stock: 9 });
  const delta = await call(sync, NOW, { body: { shopId: A, limit: 2, cursor: last.nextCursor }, shopAccess: access });
  assert.deepEqual(delta.body.items.map((i) => [i.id, i.stock]), [[`a2${n}`, 9]]);
  assert.equal(delta.body.hasMore, false);
});

test("member.indexSync: ร้านรุ่นแรก (ช่อง ≠ doc id) ใช้ shopId in [ช่อง, doc id] + orderBy updateTime, __name__ + startAfter บน emulator · เวลาเท่ากันข้ามหน้า · ร้านอื่นไม่ปน", async () => {
  const n = ns();
  const S5 = `s5doc${n}`, F = `field${n}`, B = `shopB${n}`;
  const ml = (shopId, updateTime, name) => ({ shopId, updateTime, members: [{ id: `m-${name}`, name, tel: "0000000000" }] });
  // ลำดับที่ถูก (เวลา, id): k1 k2 (µs 0 · คนละคีย์) · k3 k4 (µs 1 · คนละคีย์) · k5 (µs 3)
  await seed({
    shop: { [S5]: { shopId: F, name: "ร้านรุ่นแรก" }, [B]: { shopId: B, name: "ร้านบี" } },
    memberList: {
      [`k2${n}`]: ml(S5, TS(0), "สอง"), [`k1${n}`]: ml(F, TS(0), "หนึ่ง"),
      [`k4${n}`]: ml(F, TS(1), "สี่"), [`k3${n}`]: ml(S5, TS(1), "สาม"),
      [`k5${n}`]: ml(F, TS(3), "ห้า"),
      [`kb${n}`]: ml(B, TS(0), "ร้านอื่น"),
    },
  });
  const before0 = await dump();
  const access = { shopId: S5, uid: `u${n}`, role: "staff", rights: [] };
  const pages = await allPages((cursor) => call(indexSync, NOW, { body: { shopId: S5, limit: 2, ...(cursor ? { cursor } : {}) }, shopAccess: access }));
  const ids = pages.flatMap((p) => p.lists.map((l) => l.id));
  assert.deepEqual(ids, ["k1", "k2", "k3", "k4", "k5"].map((x) => `${x}${n}`), "ครบ เรียง (เวลา, id) ข้าม 2 คีย์ ไม่ซ้ำ");
  assert.deepEqual(pages.map((p) => p.lists.length), [2, 2, 1]);
  assert.deepEqual(pages.flatMap((p) => p.lists.map((l) => l.shopId)), [F, S5, S5, F, F]);
  assert.equal(pages[0].lists[0].members[0].name, "หนึ่ง");
  assert.equal(pages[1].nextCursor, `1|${SEC}|100001000|k4${n}`);
  assert.deepEqual(await dump(), before0, "ไม่เขียนอะไร");
});

test("report.billList: หลายหน้าบน emulator · บิลเวลาเท่ากัน 6 ใบข้ามรอยต่อหน้า · ร้านรุ่นแรก 2 คีย์รวมกันเรียงถูก · ร้านอื่นไม่ปน", async () => {
  const n = ns();
  const S5 = `s5bill${n}`, F = `fbill${n}`, B = `shopB${n}`, owner = `u-owner${n}`;
  const shop = (field) => ({
    shopId: field, name: "ร้าน", cutOff: T("2010-12-31T20:00:00.000Z"), // ตัดวัน 03:00 ไทย
    vip: [{ type: "premium", expire: T("2027-01-01T00:00:00.000Z") }],
    humanResource: [{ id: owner, name: "เจ้าของ", position: ["001"], status: "active" }],
  });
  const bill = (shopId, iso, no) => ({
    shopId, receiptNumber: `R${no}`, dateTime: T(iso), moneyMustPaid: 10, product: [{ id: "p1", qty: 1, name: "น้ำ", net: 10, totalPrice: 10 }],
    payment: [{ id: 1, name: "เงินสด", amount: 10 }], member: {},
  });
  const TIE = "2026-11-10T05:00:00.000Z";
  await seed({
    shop: { [S5]: shop(F), [B]: shop(B) },
    bill: {
      [`z1${n}`]: bill(S5, "2026-11-10T07:00:00.000Z", 1),
      // เวลาเท่ากัน 6 ใบ · คีย์ doc id ถือ 4 ใบ (> pageSize+1) ⇒ ถ้าไม่ startAfter ด้วย __name__ จะหายที่รอยต่อหน้า (คู่เทียบ: byId:false แดง)
      [`t1${n}`]: bill(F, TIE, 2), [`t2${n}`]: bill(S5, TIE, 3), [`t3${n}`]: bill(F, TIE, 4), [`t4${n}`]: bill(S5, TIE, 5),
      [`t5${n}`]: bill(S5, TIE, 10), [`t6${n}`]: bill(S5, TIE, 11),
      [`y1${n}`]: bill(F, "2026-11-10T04:00:00.000Z", 6),
      [`w1${n}`]: { ...bill(S5, "2026-11-10T03:30:00.000Z", 7), void: true },
      [`bb${n}`]: bill(B, TIE, 8),
      [`out${n}`]: bill(S5, "2026-11-12T05:00:00.000Z", 9), // นอกช่วง
    },
  });
  const before0 = await dump();
  const access = { shopId: S5, uid: owner, role: "owner", rights: [] };
  const range = { shopId: S5, fromDay: "20261110", toDay: "20261110" };
  const pages = await allPages((cursor) => call(billList, NOW, { body: { ...range, pageSize: 2, ...(cursor ? { cursor } : {}) }, shopAccess: access }));
  const ids = pages.flatMap((p) => p.rows.map((r) => r.id));
  // ใหม่ก่อน · เวลาเท่ากันเรียง doc id มากก่อน (orderBy dateTime desc, __name__ desc)
  assert.deepEqual(ids, ["z1", "t6", "t5", "t4", "t3", "t2", "t1", "y1", "w1"].map((x) => `${x}${n}`));
  assert.deepEqual(pages.map((p) => p.rows.length), [2, 2, 2, 2, 1]);
  assert.deepEqual(pages[0].nextCursor, { at: TIE, id: `t6${n}` });
  assert.equal(pages[pages.length - 1].nextCursor, null);
  assert.deepEqual(await dump(), before0, "ไม่เขียนอะไร");
});
