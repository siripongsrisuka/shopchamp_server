// firestore.office.test.mjs — ของ shopchampoffice (DEV-0003) = server เท่านั้น · client แตะไม่ได้ทุกคน รวม watcher/root/ทีมงานเลนเก่า
//   กุญแจ passkey · challenge ค้าง · รอยการกระทำ · บันทึกการแก้ทะเบียน watcherRosterLog
//   พิสูจน์ 2 ทิศ: ลบ match ของ office ออกแล้วยังต้องเขียว (ไม่มี match = ปัด) · ใส่ allow true แล้วต้องแดง
import { test, before, beforeEach, after } from "node:test";
import { assertFails } from "@firebase/rules-unit-testing";
import { doc, collection, getDoc, getDocs, setDoc, addDoc, deleteDoc, query, where } from "firebase/firestore";
import { makeEnv, seedAll, as, U } from "./fixtures.mjs";

let env;
before(async () => { env = await makeEnv("demo-shopchamp-rules-office"); });
beforeEach(async () => {
  await seedAll(env);
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, "watcher", "roster"), { uids: [U.watcher, U.team], rootUids: [U.team] });
    await setDoc(doc(db, "officePasskeys", "cred1"), { uid: U.team, publicKey: "AQID", counter: 1 });
    await setDoc(doc(db, "officePasskeyChallenges", U.team), { challenge: "c", type: "auth" });
    await setDoc(doc(db, "officeAudit", "a1"), { action: "watcher.roster.save", actorUid: U.team });
    await setDoc(doc(db, "watcherRosterLog", "l1"), { by: "x" });
  });
});
after(async () => { await env?.cleanup(); });

const COLLS = [["officePasskeys", "cred1"], ["officePasskeyChallenges", U.team], ["officeAudit", "a1"], ["watcherRosterLog", "l1"]];
const WHO = [["root (อยู่ใน rootUids)", U.team], ["watcher", U.watcher], ["ทีมงานเว็บเลนเก่า", U.teamWeb], ["เจ้าของร้าน", U.ownerA], ["คนนอก", U.outsider]];

for (const [c, id] of COLLS) {
  for (const [who, u] of WHO) {
    test(`[OFFICE DENY] ${who} อ่าน ${c}/${id}`, async () => { await assertFails(getDoc(doc(as(env, u), c, id))); });
    test(`[OFFICE DENY] ${who} list ${c}`, async () => { await assertFails(getDocs(collection(as(env, u), c))); });
    test(`[OFFICE DENY] ${who} เขียน/สร้าง/ลบ ${c}`, async () => {
      await assertFails(setDoc(doc(as(env, u), c, id), { uid: u, challenge: "mine" }));
      await assertFails(addDoc(collection(as(env, u), c), { uid: u }));
      await assertFails(deleteDoc(doc(as(env, u), c, id)));
    });
  }
  test(`[OFFICE DENY] ไม่ login อ่าน ${c}`, async () => { await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), c, id))); });
}
test("[OFFICE DENY] root query กุญแจของตัวเอง (where uid ==) ไม่ได้", async () => {
  await assertFails(getDocs(query(collection(as(env, U.team), "officePasskeys"), where("uid", "==", U.team))));
});
