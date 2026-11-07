// pos/office/passkey — พิธี passkey (WebAuthn) ของ shopchampoffice · ยกแบบจากบ้านพี่น้อง (adminharness/passkeyCallables.js) (DEV-0003)
//
// สัญญา: shopchamp-center/api/office.passkeyRegisterOptions.yaml · …RegisterVerify · …AssertOptions · …AssertVerify
// ใครทำได้: root เท่านั้น (watcher เขียนอะไรไม่ได้ ⇒ ไม่ต้องมีกุญแจ · fail-closed)
// หลัก (ยกมา):
//   challenge อยู่ที่ server · 1 ใบต่อคน · ใช้ครั้งเดียว (อ่าน+ลบใน transaction) · หมดอายุ 5 นาที
//   userVerification 'required' ตั้งแต่ลงทะเบียน · ตรวจด้วย requireUserVerification: true ทุกครั้ง
//   กุญแจไม่เกิน 3 ใบต่อคน · มีอยู่แล้ว = ต้องแตะกุญแจเดิมก่อนเพิ่มใบใหม่ (คนเดินมาที่จอเปิดค้างเพิ่มนิ้วตัวเองไม่ได้)
//   ⚠️ ลำดับใน registerOptions: ตรวจลายนิ้วเดิม (กิน challenge 'auth') ก่อน แล้วค่อยเขียน challenge 'register' ทับ
// ทุกการลงทะเบียนสำเร็จ = officeAudit 'passkey.register'
"use strict";

const { db } = require("../../firebase");
const {
  OfficePasskeyRegisterOptionsRequest, OfficePasskeyRegisterVerifyRequest, OfficePasskeyAssertOptionsRequest, OfficePasskeyAssertVerifyRequest,
} = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const S = require("./_officeStore");
const C = require("./_officeCore");

function wrap(schema, run) {
  return (deps) => async function handler(req, res) {
    try {
      S.callerOf(req);
      const input = parseOr400(schema, req.body, res);
      if (!input) return undefined;
      const g = await S.gate(req, "root");
      const now = await readNow(deps);
      return await run({ req, res, input, g, now, tools: S.toolsOf(deps) });
    } catch (e) {
      if (e instanceof S.Refusal) return sendDeny(res, e.deny);
      return internalError(res, e);
    }
  };
}

const registerOptions = wrap(OfficePasskeyRegisterOptionsRequest, async ({ res, input, g, now, tools }) => {
  const rp = S.rpOr400(input.origin);
  const existing = await S.listCredentials(g.uid);
  const d = C.decideEnroll({ count: existing.length, max: C.MAX_PASSKEYS_PER_USER, hasAssertion: !!input.authResp });
  if (!d.allow) S.refuse(409, d.code, undefined, { count: existing.length, max: C.MAX_PASSKEYS_PER_USER });
  if (existing.length > 0) await S.verifyAssertion({ uid: g.uid, origin: input.origin, authResp: input.authResp, now, tools });
  const options = await tools.generateRegistrationOptions({
    rpName: C.RP_NAME,
    rpID: rp.rpID,
    userName: g.email || g.uid,
    userID: new Uint8Array(Buffer.from(g.uid, "utf8")),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: Array.isArray(c.transports) ? c.transports : [] })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  if (!options || typeof options.challenge !== "string") throw new Error("generateRegistrationOptions ไม่คืน challenge");
  await S.saveChallenge(g.uid, { challenge: options.challenge, type: "register", origin: rp.origin }, now);
  return ok(res, { options });
});

const registerVerify = wrap(OfficePasskeyRegisterVerifyRequest, async ({ res, input, g, now, tools }) => {
  const rp = S.rpOr400(input.origin);
  const { challenge } = await S.consumeChallenge(g.uid, "register", rp.origin, now);
  let v;
  try {
    v = await tools.verifyRegistrationResponse({ response: input.attResp, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true });
  } catch (e) {
    try { console.warn("office passkey register throw", e && e.message); } catch (_) { /* */ }
    S.refuse(403, "enroll_failed");
  }
  const info = v && v.registrationInfo;
  const cred = info && info.credential;
  if (!v || v.verified !== true || !cred || typeof cred.id !== "string" || !cred.id || !cred.publicKey) S.refuse(403, "enroll_failed");
  const label = (input.label || "").trim() || "passkey";
  const ref = db.collection(S.PASSKEYS).doc(cred.id);
  const credentialId = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return null;
    tx.create(ref, {
      uid: g.uid, publicKey: C.b64url(cred.publicKey), counter: Number(cred.counter) || 0, transports: Array.isArray(cred.transports) ? cred.transports : [],
      deviceType: info.credentialDeviceType || null, backedUp: info.credentialBackedUp === true, label, rpID: rp.rpID, createdAt: now,
    });
    tx.create(S.auditRef(now, g.uid, "passkey.register", cred.id), S.auditEntry({ action: "passkey.register", result: "ok", actor: g, passkeyCredentialId: cred.id, now, extra: { label, rpID: rp.rpID } }));
    return cred.id;
  });
  if (!credentialId) S.refuse(409, "credential_exists");
  return ok(res, { verified: true, credentialId, label });
});

const assertOptions = wrap(OfficePasskeyAssertOptionsRequest, async ({ res, input, g, now, tools }) => {
  const rp = S.rpOr400(input.origin);
  const creds = (await S.listCredentials(g.uid)).filter((c) => !c.rpID || c.rpID === rp.rpID);
  if (!creds.length) S.refuse(409, "no_credentials");
  const options = await tools.generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: creds.map((c) => ({ id: c.id, transports: Array.isArray(c.transports) ? c.transports : [] })),
    userVerification: "required",
  });
  if (!options || typeof options.challenge !== "string") throw new Error("generateAuthenticationOptions ไม่คืน challenge");
  await S.saveChallenge(g.uid, { challenge: options.challenge, type: "auth", origin: rp.origin }, now);
  return ok(res, { options });
});

// ทดสอบพิธีล้วน (ปุ่ม "ทดสอบกุญแจ" · ไม่ผูกการกระทำ)
const assertVerify = wrap(OfficePasskeyAssertVerifyRequest, async ({ res, input, g, now, tools }) => {
  const r = await S.verifyAssertion({ uid: g.uid, origin: input.origin, authResp: input.authResp, now, tools });
  return ok(res, { verified: true, credentialId: r.credentialId });
});

module.exports = { registerOptions, registerVerify, assertOptions, assertVerify };
