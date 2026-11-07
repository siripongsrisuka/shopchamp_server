// firestore.weblogin.test.mjs — webLogin/{sessionId} (DEV-0001 · ลิงก์ login ใช้ครั้งเดียว) = server เท่านั้น
//   client ทุกคน (เจ้าของ · บัญชีกลาง · คนนอก · ไม่ login) อ่าน/เขียน/ปั้น doc เองไม่ได้ ⇒ ปิดทางปั้น {status:'approved', startedBy:<เหยื่อ>} ที่ชั้น rules
//   (rules ที่ live ยังเปิด ⇒ ตอนนี้ยามจริงคือผนึก HMAC ใน server · เทสนี้คุม rules ชุดใหม่ที่จะขึ้นขั้น 7 ของ morning-deploy.md)
//   พิสูจน์ 2 ทิศ: ลบ match ของ webLogin แล้วยังต้องเขียว (ไม่มี match = ปัด) · ใส่ allow true แล้วต้องแดง · RULES_FILE=rules ที่ live = แดง
import { test, before, beforeEach, after } from "node:test";
import { assertFails } from "@firebase/rules-unit-testing";
import { doc, collection, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc } from "firebase/firestore";
import { makeEnv, seedAll, as, asShared, U } from "./fixtures.mjs";

let env;
const SID = "PendPendPendPendPend";
before(async () => { env = await makeEnv("demo-shopchamp-rules-weblogin"); });
beforeEach(async () => {
  await seedAll(env);
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), "webLogin", SID), { v: 1, status: "pending", startedBy: U.ownerA, secretHash: "a".repeat(64), seal: "b".repeat(64) });
  });
});
after(async () => { await env?.cleanup(); });

const WHO = [["เจ้าของรอบ", () => as(env, U.ownerA)], ["บัญชีกลาง owner@", () => asShared(env)], ["คนนอก", () => as(env, U.outsider)], ["ทีมงาน", () => as(env, U.team)]];
for (const [who, db] of WHO) {
  test(`[WEBLOGIN DENY] ${who} อ่าน/list`, async () => {
    await assertFails(getDoc(doc(db(), "webLogin", SID)));
    await assertFails(getDocs(collection(db(), "webLogin")));
  });
  test(`[WEBLOGIN DENY] ${who} ปั้น doc approved ของเหยื่อ · แก้ status · ลบ`, async () => {
    await assertFails(setDoc(doc(db(), "webLogin", "EvilEvilEvilEvilEvil"), { status: "approved", startedBy: U.ownerB, secretHash: "c".repeat(64), seal: "d".repeat(64) }));
    await assertFails(addDoc(collection(db(), "webLogin"), { status: "approved", startedBy: U.ownerB }));
    await assertFails(updateDoc(doc(db(), "webLogin", SID), { status: "approved" }));
    await assertFails(deleteDoc(doc(db(), "webLogin", SID)));
  });
}
test("[WEBLOGIN DENY] ไม่ login อ่าน/เขียน", async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, "webLogin", SID)));
  await assertFails(setDoc(doc(db, "webLogin", "EvilEvilEvilEvilEvil"), { status: "approved" }));
});
