// pos/e2e/franchise.e2e.js — เว็บแฟรนไชส์ครบวงบน emulator (ก้อน 9f · DEV-0002)
//   สร้างแฟรนไชส์ → หมวด → คลัง → ผูกกลุ่ม → พนักงาน → ผูกสาขา → บิล · ทุกขั้นเขียนฐานจริงของ emulator แล้วอ่านกลับ
//   เทียบกับตัวอ่าน: schema อ่าน (Franchise · WarehouseItem · StockLink) และรูปที่เว็บเดิมอ่าน (array-contains humanResource · where franchiseId)
// รัน: cd functions && npm run test:e2e
"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const S = require("@shopchamp/schema");
const E = require("./_env");
const R = require("../franchise/read");
const FR = require("../franchise/franchise");
const W = require("../franchise/warehouse");
const L = require("../franchise/link");
const B = require("../franchise/branch");
const ST = require("../franchise/staff");
const { billList } = require("../franchise/billList");
const { breakdown } = require("../franchise/breakdown");

const { call, seed, get, clock, reqId, T } = E;
const NOW = clock("2026-11-10T03:00:00.000Z");
const parseOk = (schema, doc, label) => {
  const r = schema.safeParse(doc);
  assert.ok(r.success, `${label} ไม่ผ่าน schema: ${String(JSON.stringify(r.error && r.error.issues)).slice(0, 600)}`);
};

before(() => E.ready());

test("แฟรนไชส์ครบวง: สร้าง · หมวด · คลัง · ผูกกลุ่ม · พนักงาน · สาขา · บิล", async () => {
  const n = E.ns();
  const owner = `own-${n}`, staff = `stf-${n}`, admin = `adm-${n}`, other = `oth-${n}`;
  const shopFree = `shopFree-${n}`, shopOther = `shopOther-${n}`, otherF = `FB-${n}`;
  await seed({
    admin: { adminConfig: { admin: [admin] } },
    watcher: { roster: { uids: [admin], rootUids: [admin] } }, // DEV-0001 watcher: admin = root
    profile: {
      [owner]: { name: "เจ้าของแบรนด์", tel: `08${n.slice(0, 8)}`, email: "o@x.th", imageId: "", port: [{ shopId: "zz" }] },
      [staff]: { name: "พนักงาน", tel: `09${n.slice(0, 8)}`, email: "s@x.th", imageId: "", currentLogin: { shopId: "zz" } },
    },
    franchise: { [otherF]: { name: "แฟรนไชส์อื่น", humanResource: [other], humanRight: [{ id: other, rights: ["128"] }], warehouseCategory: [] } },
    shop: {
      [shopFree]: { shopId: shopFree, name: "ร้านใหม่", tel: `07${n.slice(0, 8)}`, franchiseId: "", cutOff: T("2011-01-01T04:00:00.000+07:00"), humanResource: [{ id: "x", password: "1234" }] },
      [shopOther]: { shopId: shopOther, name: "สาขาของคนอื่น", tel: `07${n.slice(0, 8)}`, franchiseId: otherF },
    },
  });

  // 1) สร้าง · ผู้สร้างเป็นสมาชิก (DI-45) · กดซ้ำได้ใบเดิม
  const fid = reqId();
  const c1 = await call(FR.create, NOW, { body: { franchiseUUID: fid, name: "แบรนด์ทดสอบ" }, auth: { uid: owner } });
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  const c2 = await call(FR.create, NOW, { body: { franchiseUUID: fid, name: "แบรนด์ทดสอบ" }, auth: { uid: owner } });
  assert.equal(c2.body.duplicate, true);
  let f = await get("franchise", fid);
  parseOk(S.Franchise, f, "franchise ใหม่");
  assert.deepEqual(f.humanResource, [owner]);
  assert.ok(!("port" in f.humanRight[0]), "แถวผู้สร้างมีช่องของ profile");
  const list = await call(R.list, NOW, { body: {}, auth: { uid: owner } });
  assert.ok(list.body.franchises.some((x) => x.id === fid), "สร้างแล้วต้องเห็นในรายการของตัวเอง (DI-45)");

  // 2) หมวด · seen ไม่ตรง = 409
  const CAT = [{ level: 1, value: [{ id: `c1${n}`, name: "เครื่องดื่ม", level: 1, aboveId: [] }] }, { level: 2, value: [{ id: `c11${n}`, name: "น้ำ", level: 2, aboveId: [`c1${n}`] }] }];
  const k1 = await call(FR.categorySave, NOW, { body: { franchiseId: fid, warehouseCategory: CAT, seenWarehouseCategory: [] }, auth: { uid: owner } });
  assert.equal(k1.status, 200, JSON.stringify(k1.body));
  const k2 = await call(FR.categorySave, NOW, { body: { franchiseId: fid, warehouseCategory: [CAT[0]], seenWarehouseCategory: [] }, auth: { uid: owner } });
  assert.equal(k2.status, 409);
  f = await get("franchise", fid);
  assert.deepEqual(f.warehouseCategory, CAT);

  // 3) คลัง · สร้าง 2 ตัว · แก้ราคา
  const w1 = reqId(), w2 = reqId();
  for (const [id, name, unit] of [[w1, "น้ำขวด", "ขวด"], [w2, "น้ำลัง", "ลัง"]]) {
    const r = await call(W.warehouseSave, NOW, { body: { franchiseId: fid, op: "create", itemUUID: id, name, price: 10, unit, category: [`c1${n}`, `c11${n}`] }, auth: { uid: owner } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const up = await call(W.warehouseSave, NOW, { body: { franchiseId: fid, op: "update", itemId: w1, price: 12 }, auth: { uid: owner } });
  assert.deepEqual(up.body.updated, ["price"]);
  const item = await get("warehouseItem", w1);
  parseOk(S.WarehouseItem, item, "warehouseItem");
  assert.equal(item.price, 12);
  assert.equal(item.stock, 0);
  // ตัวอ่านเดิมของเว็บ: where franchiseId == fid
  const wl = await call(R.warehouseList, NOW, { body: { franchiseId: fid }, auth: { uid: owner } });
  assert.equal(wl.body.count, 2);

  // 4) ผูกกลุ่ม · แก้ชื่อสินค้าแล้วสำเนาในกลุ่มตาม · ลบสินค้าที่อยู่ในกลุ่มไม่ได้
  const lk = reqId();
  const ls = await call(L.linkSave, NOW, { body: { franchiseId: fid, op: "create", linkUUID: lk, stockGroupName: "น้ำ", members: [{ id: w1, linkMultiply: 1 }, { id: w2, linkMultiply: 12 }] }, auth: { uid: owner } });
  assert.equal(ls.status, 200, JSON.stringify(ls.body));
  const link = await get("stockLink", lk);
  parseOk(S.StockLink, link, "stockLink");
  const { createdBy, ...written } = link;
  assert.equal(createdBy, owner);
  parseOk(S.StockLinkWrite, { ...written, timestamp: link.timestamp.toDate() }, "stockLink รูปเขียน");
  assert.equal(link.shopId, "");
  await call(W.warehouseSave, NOW, { body: { franchiseId: fid, op: "update", itemId: w2, name: "น้ำลัง 12" }, auth: { uid: owner } });
  assert.equal((await get("stockLink", lk)).stockLink.find((m) => m.id === w2).name, "น้ำลัง 12");
  const del = await call(W.warehouseDelete, NOW, { body: { franchiseId: fid, itemId: w2 }, auth: { uid: owner } });
  assert.equal(del.status, 409);
  assert.ok(await get("warehouseItem", w2));
  // คนของแฟรนไชส์อื่นแตะไม่ได้
  const cross = await call(L.linkDelete, NOW, { body: { franchiseId: otherF, linkId: lk }, auth: { uid: other } });
  assert.equal(cross.status, 409);

  // 5) พนักงาน · เพิ่ม · เพิ่มซ้ำ 409 · ถอด 723 ของคนสุดท้ายไม่ได้
  const s1 = await call(ST.staffSave, NOW, { body: { franchiseId: fid, op: "add", staffUid: staff, rights: ["128"] }, auth: { uid: owner } });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  const s2 = await call(ST.staffSave, NOW, { body: { franchiseId: fid, op: "add", staffUid: staff, rights: [] }, auth: { uid: owner } });
  assert.equal(s2.status, 409);
  const s3 = await call(ST.staffSave, NOW, { body: { franchiseId: fid, op: "update", staffUid: owner, rights: ["100"] }, auth: { uid: owner } });
  assert.equal(s3.body.error, "last_staff_admin");
  f = await get("franchise", fid);
  parseOk(S.Franchise, f, "franchise หลังเพิ่มพนักงาน");
  assert.deepEqual(f.humanResource, [owner, staff]);
  assert.ok(!("currentLogin" in f.humanRight[1]));
  // ตัวอ่านเดิมของเว็บ: franchise where humanResource array-contains uid
  const byStaff = await call(R.list, NOW, { body: {}, auth: { uid: staff } });
  assert.ok(byStaff.body.franchises.some((x) => x.id === fid));
  // พนักงานสิทธิ์ 128 อย่างเดียว ดูยอดไม่ได้
  const noReport = await call(billList, NOW, { body: { franchiseId: fid, fromDay: "20261110", toDay: "20261110" }, auth: { uid: staff } });
  assert.equal(noReport.status, 403);

  // 6) สาขา · เจ้าของแบรนด์ผูกเองไม่ได้ · ทีมงานผูก · ร้านของแฟรนไชส์อื่นไม่ทับ
  assert.equal((await call(B.branchAttach, NOW, { body: { franchiseId: fid, shopId: shopFree }, auth: { uid: owner } })).status, 403);
  const at = await call(B.branchAttach, NOW, { body: { franchiseId: fid, shopId: shopFree }, auth: { uid: admin } });
  assert.equal(at.status, 200, JSON.stringify(at.body));
  assert.equal((await call(B.branchAttach, NOW, { body: { franchiseId: fid, shopId: shopOther }, auth: { uid: admin } })).status, 409);
  assert.equal((await get("shop", shopOther)).franchiseId, otherF);
  const shopDoc = await get("shop", shopFree);
  assert.equal(shopDoc.franchiseId, fid);
  assert.equal(shopDoc.humanResource[0].password, "1234", "ช่องอื่นของร้านต้องไม่ถูกแตะ");
  const bl = await call(R.branchList, NOW, { body: { franchiseId: fid }, auth: { uid: owner } });
  assert.deepEqual(bl.body.branches.map((b) => b.id), [shopFree]);
  assert.ok(!JSON.stringify(bl.body).includes("1234"));

  // 7) บิล · cutOff 04:00 ของสาขา · ใบยกเลิกนับแยก
  const b = (id, iso, over) => ({ [id]: { franchiseId: fid, shopId: shopFree, billDate: iso.slice(0, 10).replace(/-/g, ""), dateTime: T(iso), receiptNumber: id, moneyMustPaid: 100, product: [{ id: "p", name: "น้ำ", qty: 1, net: 100 }], ...over } });
  await seed({ bill: {
    ...b(`bA${n}`, "2026-11-10T05:00:00.000Z"),
    ...b(`bB${n}`, "2026-11-10T19:00:00.000Z", { billDate: "20261111" }), // 02:00 ไทยวันที่ 11 ก่อนตัดรอบ ⇒ วัน 10
    ...b(`bC${n}`, "2026-11-10T06:00:00.000Z", { void: true, moneyMustPaid: 40 }),
  } });
  const rep = await call(billList, NOW, { body: { franchiseId: fid, fromDay: "20261110", toDay: "20261110" }, auth: { uid: owner } });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.deepEqual(rep.body.bills.map((x) => x.id).sort(), [`bA${n}`, `bB${n}`].sort());
  assert.deepEqual(rep.body.voided, { count: 1, net: 40 });

  // 8) ยอดแฟรนไชส์สูตรกลาง (Pack เคาะ 2026-11-07) · บิลชุดเดียวกับข้อ 7 + ส่วนลดท้ายบิล 10 กระจายลงสินค้า
  await seed({ bill: b(`bD${n}`, "2026-11-10T07:00:00.000Z", { moneyMustPaid: 90, manualDiscount: 10, product: [{ id: "p", name: "น้ำ", barcode: "885001", qty: 1, net: 100, totalPrice: 100 }] }) });
  const bd = await call(breakdown, NOW, { body: { franchiseId: fid, fromDay: "20261110", toDay: "20261110" }, auth: { uid: owner } });
  assert.equal(bd.status, 200, JSON.stringify(bd.body));
  assert.deepEqual([bd.body.totals.billQty, bd.body.totals.totalSale, bd.body.totals.voidQty, bd.body.totals.voidTotal], [3, 290, 1, 40]);
  assert.deepEqual(bd.body.shops.map((x) => [x.shopId, x.totalSale, x.inFranchise]), [[shopFree, 290, true]]);
  assert.equal(bd.body.items.find((x) => x.key === "bc:885001").netAfterBillDiscount, 90);
  assert.equal((await call(breakdown, NOW, { body: { franchiseId: fid, fromDay: "20261110", toDay: "20261110" }, auth: { uid: staff } })).status, 403);
});
