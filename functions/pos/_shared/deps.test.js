// เทส deps.js · รัน: node --test functions/pos/_shared/
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readNow, depOr } = require("./deps");

test("readNow: ไม่ส่ง deps / ไม่ส่ง now = นาฬิกาจริง", async () => {
  const before = Date.now();
  for (const d of [undefined, null, {}, { now: null }]) {
    const t = await readNow(d);
    assert.ok(t instanceof Date);
    assert.ok(t.getTime() >= before && t.getTime() <= Date.now() + 5);
  }
});

test("readNow: stub รูปที่ harness สร้าง (sync และ async) ได้ Date เดิม · เรียกครั้งเดียว · คืนสำเนา", async () => {
  const fixed = new Date("2026-11-10T03:00:00.000Z");
  let n = 0;
  const sync = { now: () => { n++; return fixed; } };
  const t = await readNow(sync);
  assert.equal(t.toISOString(), "2026-11-10T03:00:00.000Z");
  assert.equal(n, 1);
  assert.notEqual(t, fixed); // แก้ตัวที่ได้ไม่กระทบ stub
  const t2 = await readNow({ now: async () => fixed });
  assert.equal(t2.getTime(), fixed.getTime());
});

test("readNow: now ผิดรูป = throw (ทิศที่ต้องปัด · นาฬิกาเพี้ยนไม่ออกเลขบิล)", async () => {
  for (const bad of [{ now: 5 }, { now: () => "2026-11-10T03:00:00Z" }, { now: () => new Date("x") }, { now: () => 1794279600000 }, { now: () => null }]) {
    await assert.rejects(readNow(bad));
  }
});

test("depOr: ไม่ส่ง = fallback · ส่งฟังก์ชัน = ตัวที่ส่ง · ส่งผิดรูป = throw", () => {
  const real = () => "real";
  const stub = () => "stub";
  assert.equal(depOr(undefined, "createSale", real), real);
  assert.equal(depOr({}, "createSale", real), real);
  assert.equal(depOr({ createSale: stub }, "createSale", real), stub);
  assert.throws(() => depOr({ createSale: { returns: 1 } }, "createSale", real));
});
