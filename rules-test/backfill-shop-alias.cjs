#!/usr/bin/env node
// backfill-shop-alias.cjs — สร้างดัชนี shopAlias/{field shopId} = { docIds:[doc id ร้าน] } ให้ร้านรุ่นเก่า (S5) ก่อนปล่อย rules ก้อน 6
//
// ทำไมต้องมี: ร้านรุ่นเก่าราว 19% (chunk4-verify/sale.get.md) field shopId = uid เจ้าของ ≠ doc id
//   ⇒ เอกสารของร้านเหล่านี้ (stock bill member …) ถือ shopId = uid · rules หา doc ร้านจากค่านี้เองไม่ได้ (query ใน rules ไม่ได้)
//   ⇒ เจ้าของผ่านด้วย key == uid · **พนักงาน** ต้องผ่านดัชนีนี้ ไม่งั้นพนักงานร้านเก่าทั้งหมดใช้แอปไม่ได้ทันทีที่ rules ขึ้น
// ประชากร: ร้านรุ่นเก่าเป็นกลุ่มปิด (ร้านใหม่ทุกทางได้ shopId = doc id · rules ใหม่ห้ามเปลี่ยน field shopId) ⇒ รันครั้งเดียวพอ
//   ถ้ารันซ้ำ = ทับค่าเดิมด้วยผลใหม่ (idempotent)
//
// ใช้ (มือ Pack · เขียนฐานจริง):
//   cd shopchamp_server/rules-test
//   GOOGLE_APPLICATION_CREDENTIALS=<กุญแจ service account> node backfill-shop-alias.cjs --project shopcham-24b0b            (นับอย่างเดียว)
//   GOOGLE_APPLICATION_CREDENTIALS=<กุญแจ service account> node backfill-shop-alias.cjs --project shopcham-24b0b --write    (เขียนจริง)
// เทสกับ emulator: FIRESTORE_EMULATOR_HOST=127.0.0.1:<port> node backfill-shop-alias.cjs --project demo-x --write
"use strict";
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

// ร้านที่ field shopId ชี้ doc id ของร้านอื่น = ห้ามทำดัชนี (ดัชนีชนะ doc จริงใน rules ⇒ จะครอบร้านนั้น) · รายงานแยก
async function buildAliases(db, { write = false, pageSize = 1000, log = console.log } = {}) {
  const groups = new Map();
  let scanned = 0; let last = null; let hrOver80 = 0; // rules ไล่รายชื่อได้ 80 ช่องแรก (firestore.rules hrGroup0..7) · นับอย่างเดียว ไม่พิมพ์รายชื่อ
  for (;;) {
    let q = db.collection("shop").select("shopId", "humanResource").orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      scanned += 1;
      const hr = d.get("humanResource");
      if (Array.isArray(hr) && hr.length > 80) hrOver80 += 1;
      const v = d.get("shopId");
      if (typeof v === "string" && v !== "" && v !== d.id) {
        if (!groups.has(v)) groups.set(v, []);
        groups.get(v).push(d.id);
      }
    }
    last = snap.docs[snap.docs.length - 1];
  }
  const skipped = []; const aliases = [];
  for (const [key, docIds] of groups) {
    if (key.includes("/")) { skipped.push({ key, why: "มี /" }); continue; }
    const clash = await db.collection("shop").doc(key).get();
    if (clash.exists) { skipped.push({ key, why: "ตรงกับ doc id ของร้านอื่น" }); continue; }
    aliases.push({ key, docIds: docIds.sort() });
  }
  const multi = aliases.filter((a) => a.docIds.length > 1).length;
  const over3 = aliases.filter((a) => a.docIds.length > 3).length; // rules ไล่แค่ 3 ตัวแรก
  log(`shop ทั้งหมด ${scanned} · ร้านรุ่นเก่า (shopId ≠ doc id) ${[...groups.values()].reduce((n, a) => n + a.length, 0)} · ดัชนี ${aliases.length} (มากกว่า 1 ร้าน ${multi} · เกิน 3 ร้าน ${over3}) · ข้าม ${skipped.length} · ร้านที่รายชื่อพนักงานเกิน 80 ${hrOver80}`);
  if (write) {
    for (let i = 0; i < aliases.length; i += 400) {
      const b = db.batch();
      for (const a of aliases.slice(i, i + 400)) b.set(db.collection("shopAlias").doc(a.key), { docIds: a.docIds, updatedAt: admin.firestore.FieldValue.serverTimestamp(), by: "backfill-shop-alias" });
      await b.commit();
    }
    log(`เขียน shopAlias ${aliases.length} ใบแล้ว`);
  }
  return { scanned, aliases, skipped, multi, over3, hrOver80 };
}

module.exports = { buildAliases };

if (require.main === module) {
  const args = process.argv.slice(2);
  const pi = args.indexOf("--project");
  const projectId = pi >= 0 ? args[pi + 1] : null;
  if (!projectId) { console.error("ต้องระบุ --project"); process.exit(64); }
  admin.initializeApp({ projectId });
  buildAliases(admin.firestore(), { write: args.includes("--write") })
    .then((r) => { if (r.skipped.length) console.log("ข้าม:", r.skipped.length, "ใบ (ไม่พิมพ์ค่า)"); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
