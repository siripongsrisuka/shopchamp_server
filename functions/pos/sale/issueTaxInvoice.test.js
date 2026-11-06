// เทส sale/issueTaxInvoice.js · รัน: node --test functions/pos/sale/issueTaxInvoice.test.js
//   ของที่เขียนลงฐานจริง (merge ของตัวนับ · รูปบิล) และลำดับเลขเมื่อเรียกต่อกันหลายใบ · harness ของสัญญาบันทึกการเขียนแต่ไม่ลงฐาน
//   ฐานปลอมเดียวกับ create.test.js (คัดลอก · ไม่ผูกข้ามไฟล์) · ❌ ไม่แตะ Firestore จริง
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const NOW = new Date("2026-11-10T03:00:00.000Z");
const ts = (iso) => { const d = new Date(iso); return { toDate: () => d, toMillis: () => d.getTime(), seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 }; };

let DATA = {};
let LOG = [];
const OPS = {
  "==": (a, b) => a === b,
  ">=": (a, b) => typeof a === typeof b && a >= b,
  "<=": (a, b) => typeof a === typeof b && a <= b,
};
function makeDb() {
  let auto = 0;
  const snapOf = (c, id) => { const d = (DATA[c] || {})[id]; return { exists: d !== undefined, id, data: () => d }; };
  const run = (c, filters, n) => Object.entries(DATA[c] || {})
    .filter(([, d]) => filters.every(([f, op, v]) => OPS[op](d[f], v)))
    .slice(0, n === undefined ? Infinity : n)
    .map(([id, d]) => ({ id, exists: true, data: () => d }));
  // อ่านนอก transaction (auth.resolveShopRef พิสูจน์ field ของร้าน S5): doc.get · where().limit().get
  const ref = (c, id) => ({ c, id, get: async () => snapOf(c, id) });
  const query = (c, filters) => ({
    c, filters,
    where: (f, op, v) => {
      if (!OPS[op]) throw new Error(`op ${op} ไม่รองรับในฐานปลอม`);
      return query(c, [...filters, [f, op, v]]);
    },
    limit: (n) => ({ get: async () => ({ docs: run(c, filters, n) }) }),
  });
  return {
    collection: (c) => ({
      doc: (id) => ref(c, id !== undefined ? id : `auto${++auto}`),
      where: (f, op, v) => query(c, []).where(f, op, v),
    }),
    runTransaction: async (fn) => {
      const writes = [];
      const tx = {
        get: async (r) => {
          if (writes.length) throw new Error(`อ่าน ${r.c}/${r.id || "query"} หลังเขียน (Firestore ปัด)`);
          if (r.filters) {
            const docs = Object.entries(DATA[r.c] || {})
              .filter(([, d]) => r.filters.every(([f, op, v]) => OPS[op](d[f], v)))
              .map(([id, d]) => ({ id, exists: true, data: () => d }));
            return { docs, empty: docs.length === 0 };
          }
          const d = (DATA[r.c] || {})[r.id];
          return { exists: d !== undefined, id: r.id, data: () => d };
        },
        update: (r, v) => { writes.push({ op: "update", c: r.c, id: r.id, v }); },
        set: (r, v, o) => { writes.push({ op: o && o.merge ? "merge" : "set", c: r.c, id: r.id, v }); },
      };
      const out = await fn(tx);
      for (const w of writes) {
        DATA[w.c] = DATA[w.c] || {};
        if (w.op === "update" && DATA[w.c][w.id] === undefined) throw new Error(`update ${w.c}/${w.id} ที่ไม่มี doc`);
        DATA[w.c][w.id] = w.op === "set" ? { ...w.v } : { ...DATA[w.c][w.id], ...w.v };
      }
      LOG.push(...writes);
      return out;
    },
  };
}
const fbAbs = require.resolve(path.join(__dirname, "..", "..", "firebase"));
require.cache[fbAbs] = { id: fbAbs, filename: fbAbs, loaded: true, exports: { db: makeDb(), admin: {} } };
const T = require("./issueTaxInvoice");

const OWNER = { shopId: "shopA", uid: "u-owner", role: "owner", rights: [] };
async function call(body, { now = NOW, shopAccess = OWNER } = {}) {
  const handler = T.issueTaxInvoice({ now: () => now });
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ body, shopAccess }, res);
  return res;
}
const CUST = { id: "c1", name: "บริษัท ลูกค้า จำกัด", tel: "0000000000", address: "กรุงเทพ", taxNumber: "0105500000000", branch: "สำนักงานใหญ่" };
const req = (x) => ({ shopId: "shopA", billId: "b1", taxCustomer: CUST, staffId: "u-owner", staffName: "เจ้าของ", ...x });
const bill = (x) => ({ shopId: "shopA", receiptNumber: "202611000010", moneyMustPaid: 107, ...x });
function seed(x = {}) {
  DATA = {
    shop: { shopA: { shopId: "shopA", name: "ร้านทดสอบ", ...(x.shop || {}) } },
    bill: { b1: bill(), b2: bill({ receiptNumber: "202611000011" }), b3: bill({ receiptNumber: "202611000012" }) },
    taxId: { shopA: { month: 11, receipts: 7, keepMe: "x" } },
    ...(x.data || {}),
  };
  LOG = [];
}

test("ออกเลข: ตัวนับ merge (field เดิมอยู่ครบ) · บิลได้ taxNumber taxCustomer taxIssued* · ช่องเดิมของบิลไม่หาย", async () => {
  seed();
  const r = await call(req({}));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.taxNumber, "202611000008");
  assert.deepEqual(DATA.taxId.shopA, { month: 11, receipts: 8, keepMe: "x", serverKey: 202611, serverRun: 8 });
  const b = DATA.bill.b1;
  assert.equal(b.taxNumber, "202611000008");
  assert.deepEqual(b.taxCustomer, CUST);
  assert.equal(b.taxIssuedAt.getTime(), NOW.getTime());
  assert.equal(b.taxIssuedById, "u-owner");
  assert.equal(b.receiptNumber, "202611000010");
  assert.equal(b.moneyMustPaid, 107);
});

test("ออก 3 ใบต่อกัน แล้วยิงใบแรกซ้ำ ⇒ 8 9 10 · ใบแรกได้เลขเดิม · ตัวนับหยุดที่ 10", async () => {
  seed();
  const got = [];
  for (const id of ["b1", "b2", "b3"]) got.push((await call(req({ billId: id }))).body.taxNumber);
  assert.deepEqual(got, ["202611000008", "202611000009", "202611000010"]);
  const again = await call(req({ billId: "b1" }));
  assert.equal(again.body.taxNumber, "202611000008");
  assert.equal(again.body.reused, true);
  assert.equal(DATA.taxId.shopA.receipts, 10);
});

test("สลับกับสูตรแอปเก่า: server 8 → แอปเก่าเขียน receipts 9 (update ไม่ลบ serverRun) → server ได้ 10", async () => {
  seed();
  await call(req({ billId: "b1" }));
  DATA.taxId.shopA = { ...DATA.taxId.shopA, receipts: 9 }; // แอปเก่า transaction.update(taxRef, {receipts: receipts+1})
  const r = await call(req({ billId: "b2" }));
  assert.equal(r.body.taxNumber, "202611000010");
});

test("ขึ้นเดือนใหม่ด้วยเวลา server (ไม่ใช่นาฬิกาเครื่อง) ⇒ 202612000001", async () => {
  seed();
  const r = await call(req({}), { now: new Date("2026-11-30T17:30:00.000Z") }); // 1 ธ.ค. 00:30 เวลาไทย
  assert.equal(r.body.taxNumber, "202612000001");
  assert.equal(DATA.taxId.shopA.month, 12);
});

test("floorRun จริง: receipts เสีย · บิลรอบนี้มีเลขสูงสุด 202611000004 (มีของเดือนก่อน 202610000099 ปน) ⇒ 202611000005", async () => {
  seed({ data: { taxId: { shopA: { month: 11, receipts: null } } } });
  DATA.bill.old = bill({ taxNumber: "202610000099" });
  DATA.bill.b4 = bill({ taxNumber: "202611000004" });
  const r = await call(req({}));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.taxNumber, "202611000005");
});

test("ปัดแล้วไม่เขียนอะไร: บิลยกเลิก · สิทธิ์ไม่พอ · บิลร้านอื่น", async () => {
  seed({ data: { bill: { b1: bill({ void: true }), bB: bill({ shopId: "shopB" }) } } });
  assert.equal((await call(req({}))).body.error, "bill_void");
  assert.equal((await call(req({}), { shopAccess: { ...OWNER, uid: "u-staff", role: "staff", rights: ["116"] } })).body.error, "right_required");
  assert.equal((await call(req({ billId: "bB" }))).body.error, "bill_other_shop");
  assert.equal(LOG.length, 0);
  assert.equal(DATA.taxId.shopA.receipts, 7);
});

test("sameCustomer เทียบทุกช่อง ไม่สนลำดับ key", () => {
  assert.equal(T.sameCustomer({ a: 1, b: "x" }, { b: "x", a: 1 }), true);
  assert.equal(T.sameCustomer({ a: 1 }, { a: 1, b: undefined }), true);
  assert.equal(T.sameCustomer({ a: 1 }, { a: 2 }), false);
  assert.equal(T.sameCustomer(undefined, { a: 1 }), false);
});
