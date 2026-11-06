// pos/member/rebuildIndex — สร้างดัชนีค้นหา memberList ใหม่จากสมาชิกจริงของร้าน (ก้อน 9b · DEV-0001)
//
// สัญญา: shopchamp-center/api/member.rebuildIndex.yaml · คำขอ MemberRebuildIndexRequest
// ทางเดิมที่แทน: `main3:src/hook/useLocalMember.js:48-88` (W8 + L4) ซึ่งเข้าเฉพาะตอน MMKV ว่าง (F24) · สุ่มตัวอักษรใหม่ให้ทุกคน
//   แม้คนที่มีแล้ว (F26) · `batch.set` ทับดัชนี (F27) · แถว undefined ทำทั้งก้อนล้ม (F25) · batch เดียวเกิน 500 ล้ม (F25)
//
// ใครเรียกได้: ทุกคนที่ active ในร้าน (ของเดิมรันเองตอนเปิดจอขาย ไม่มีสิทธิ์) · ไม่แตะแต้ม หนี้ ชื่อ ของสมาชิก
// ขั้น:
//   1. transaction อ่านอย่างเดียว: shop (ด่าน _gate) → shopField
//   2. อ่าน member where shopId == shopField (ทั้งหมด · query เดียวกับของเดิม)
//      ตัวอักษร: letter เดิมที่ใช้ได้ (A-Z · AA-AZ จากเว็บ) = ใช้ตามเดิม (F26) · ไม่มี/เพี้ยน = logic.letterForMemberId(id) ตายตัว (F27)
//   3. อ่าน doc ดัชนีทุกตัวของร้าน (memberList where shopId == shopField · แบบที่แอปเก่าดึง) ⇒ ตัวอักษร = ที่มีสมาชิก ∪ ที่มี doc อยู่
//      ต่อตัวอักษร 1 transaction: อ่าน doc ดัชนี + อ่าน member ของแถวที่ไม่ใช่ของสดของตัวอักษรนี้
//        member ไม่มีแล้ว = ทิ้งแถว (F13 แถวผี) · member มี letter อื่น = ทิ้งแถว (F26 ค้นเจอซ้ำ) · member มี (เพิ่มหลังอ่าน) = เก็บ (F27)
//      → logic.memberIndexMerge (แถวสดทับชื่อเก่า) → set {shopId, members, updateTime} (updateTime ใหม่ ⇒ จอขายทุกเครื่องดึงใหม่)
//      doc ที่ไม่มีของสดและไม่มีแถวต้องทิ้ง = ไม่เขียน · ทิ้งจนว่าง = set members [] (ไม่ลบ doc · แอปเก่าแทน MMKV ด้วย doc ที่ดึงได้)
//   4. สมาชิกที่ยังไม่มี letter → batch update {letter} ก้อนละ 400 (เพดาน Firestore 500 · F25)
//   ทำซ้ำได้ผลเดิม (ตัวอักษรตายตัว · merge ไม่ซ้ำแถว) ⇒ ล้มกลางทางแล้วเรียกใหม่ได้
"use strict";

const { db } = require("../../firebase");
const { MemberRebuildIndexRequest } = require("@shopchamp/schema");
const logic = require("@shopchamp/logic");
const { ok, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, adminFlag } = require("../_shared/auth");
const { Refusal, readShopForWrite, isObj } = require("./_gate");

const BATCH_MAX = 400;

function rebuildIndex(deps) {
  return async function handler(req, res) {
    try {
      const body = isObj(req && req.body) ? req.body : {};
      const gate = callerAccess(req, body.shopId);
      if (!gate.ok) return sendDeny(res, gate);
      const access = gate.access;
      const input = parseOr400(MemberRebuildIndexRequest, body, res);
      if (!input) return;

      const now = await readNow(deps);
      const { shopField } = await db.runTransaction((tx) => readShopForWrite({ tx, shopDocId: access.shopId, access, now }));

      const snap = await db.collection("member").where("shopId", "==", shopField).get();
      const groups = new Map(); // letter → rows
      const letterOf = new Map(); // id → ตัวอักษรหลังรอบนี้ (ของเดิม หรือที่จะเขียนให้)
      const needLetter = []; // [{id, letter}]
      for (const d of snap.docs) {
        const m = d.data() || {};
        const has = logic.isMemberLetter(m.letter);
        const letter = has ? m.letter : logic.letterForMemberId(d.id);
        if (!has) needLetter.push({ id: d.id, letter });
        letterOf.set(d.id, letter);
        if (!groups.has(letter)) groups.set(letter, []);
        groups.get(letter).push(logic.memberIndexRowOf(d.id, m));
      }

      // doc ดัชนีทุกตัวของร้าน (รวมตัวอักษรที่ไม่มีสมาชิกในผลอ่านแล้ว · ที่ค้างแถวซ้ำหรือแถวผี F26 F13)
      const listSnap = await db.collection("memberList").where("shopId", "==", shopField).get();
      const existingLetters = new Set();
      for (const d of listSnap.docs) {
        const L1 = d.id.endsWith(shopField) ? d.id.slice(0, d.id.length - shopField.length) : null;
        if (logic.isMemberLetter(L1)) existingLetters.add(L1);
      }
      const letters = [...new Set([...groups.keys(), ...existingLetters])].sort();
      let cleaned = 0;
      for (const letter of letters) {
        const listRef = db.collection("memberList").doc(letter + shopField);
        const fresh = groups.get(letter) || [];
        const freshIds = new Set(fresh.map((r) => r.id));
        const n = await db.runTransaction(async (tx) => {
          const cur = await tx.get(listRef);
          const existing = cur.exists ? (cur.data() || {}).members : [];
          const rows = Array.isArray(existing) ? existing : [];
          const drop = new Set();
          const ask = new Set();
          for (const r of rows) {
            if (!r || typeof r.id !== "string" || freshIds.has(r.id)) continue;
            if (letterOf.has(r.id)) drop.add(r.id); // อยู่ในผลอ่านแต่ตัวอักษรอื่น = แถวซ้ำ (F26)
            else ask.add(r.id); // ไม่อยู่ในผลอ่าน = อ่าน member ใน transaction ก่อนตัดสิน (กันสมาชิกที่เพิ่งเพิ่มหลังอ่านหาย F27)
          }
          const askIds = [...ask];
          const snaps = await Promise.all(askIds.map((id) => tx.get(db.collection("member").doc(id))));
          askIds.forEach((id, i) => {
            const m = snaps[i].exists ? snaps[i].data() || {} : null;
            if (!m) drop.add(id); // สมาชิกถูกลบแล้ว (F13)
            else if (logic.isMemberLetter(m.letter) && m.letter !== letter) drop.add(id); // แถวซ้ำ · ตัวจริงอยู่ตัวอักษรอื่น (F26)
            // ไม่มี letter ที่ใช้ได้ = เก็บไว้ (ยังบอกไม่ได้ว่าอยู่ตัวอักษรไหน)
          });
          const kept = rows.filter((r) => !(r && typeof r.id === "string" && drop.has(r.id)));
          if (!cur.exists && !fresh.length) return 0;
          if (!fresh.length && !drop.size) return 0; // doc ที่ไม่มีของสดและไม่มีอะไรต้องล้าง = ไม่เขียน
          tx.set(listRef, { shopId: shopField, members: logic.memberIndexMerge(kept, fresh), updateTime: now });
          return drop.size;
        });
        cleaned += n;
      }

      for (let i = 0; i < needLetter.length; i += BATCH_MAX) {
        const batch = db.batch();
        for (const { id, letter } of needLetter.slice(i, i + BATCH_MAX)) batch.update(db.collection("member").doc(id), { letter });
        await batch.commit();
      }

      return ok(res, { members: snap.docs.length, lists: groups.size, lettersAssigned: needLetter.length, rowsRemoved: cleaned, ...adminFlag(access) });
    } catch (e) {
      if (e instanceof Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

module.exports = { rebuildIndex };
