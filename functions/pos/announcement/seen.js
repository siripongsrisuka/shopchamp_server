// pos/announcement/seen — แอปบันทึก "เห็นป๊อปอัปแล้ว / อ่านแล้ว / แบนเนอร์อยู่ในแถบ" ต่อคน (DEV-0003 0e)
//
// สัญญา: shopchamp-center/api/announcement.seen.yaml · route POST /pos/announcement/seen (auth shop · เส้นเขียน · watcher = 403)
// คำขอ: AnnouncementSeenRequest
//   {shopId, kind:'popup'|'read', id, cycleKey?}  ประทับ popupSeenAt / readAt **ครั้งแรกเท่านั้น** (มีแล้ว = 200 already ไม่เขียน)
//   {shopId, kind:'bannerView', ids[1..20]}       bannerViews +1 ต่อ id (FieldValue.increment) · ครบ 3 = logic ไม่ขึ้นแบนเนอร์นี้ให้คนนี้อีก
// ที่เขียน: announcement/{id}/seen/{uid} (uid = ผู้เรียก · set merge)
//   ถาวร: ต่อรอบที่ cycles.<cycleKey>.<ช่อง> · รอบ = ที่ server คิดเองจากสภาพร้านตอนนี้ (cycleKey ที่แอปส่งมาไม่ใช้ตัดสิน)
//         + ช่องบนสุด popupSeenAt/readAt ครั้งแรกที่เคยเห็น (ให้ office นับคนด้วย count ได้ · logic ไม่อ่านช่องนี้ของถาวร)
// ด่าน: ต้องเป็นประกาศที่คนนี้มองเห็นอยู่ตอนนี้ (ร้าน+คนผ่าน และขึ้นช่องใดช่องหนึ่ง ไม่ดู seen เดิม) ไม่งั้น 404 announcement_not_found
//   (ไม่บอกใบ้ว่า id มีอยู่) · bannerView: id ที่ไม่ได้เป็นแบนเนอร์ของคนนี้ = ข้ามเงียบ · คำตอบ {counted}
"use strict";

const { db } = require("../../firebase");
const logic = require("@shopchamp/logic");
const { AnnouncementSeenRequest } = require("@shopchamp/schema");
const { ok, deny, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess } = require("../_shared/auth");
const V = require("./_viewer");

const FIELD = Object.freeze({ popup: "popupSeenAt", read: "readAt" });
const stamped = (v) => logic.toMillis(v) !== null;

/** a ขึ้นให้คนนี้อยู่ไหม → {sees, cycleKey} · channels = ช่องที่นับ (ไม่ดู seen เดิม) */
async function seesOf(viewer, a, now, channels) {
  if (!a || !viewer.matches(a)) return { sees: false, cycleKey: null };
  let cycleKey = null;
  if (a.kind === "evergreen") {
    const m = await viewer.evergreen(a);
    if (!m.match) return { sees: false, cycleKey: null };
    cycleKey = m.cycleKey;
  } else if (a.kind !== "campaign") return { sees: false, cycleKey: null };
  return { sees: channels.some((ch) => logic.announcementChannelVisible(a, ch, null, now, cycleKey)), cycleKey };
}

function seen(deps) {
  return async function handler(req, res) {
    const input = parseOr400(AnnouncementSeenRequest, req && req.body, res);
    if (!input) return undefined;
    const a0 = callerAccess(req, input.shopId);
    if (!a0.ok) return sendDeny(res, a0);
    const uid = a0.access.uid;
    try {
      const now = await readNow(deps);
      const viewer = await V.viewerOf(a0.access.shopId, uid, now);

      if (input.kind === "bannerView") {
        const ids = [...new Set(input.ids)];
        const snaps = await db.getAll(...ids.map((id) => V.annCol().doc(id)));
        const inc = V.fieldValue().increment(1);
        const batch = db.batch();
        let counted = 0;
        for (let i = 0; i < ids.length; i++) {
          const s = snaps[i];
          if (!s || !s.exists) continue;
          const a = { ...(s.data() || {}), id: ids[i] };
          const r = await seesOf(viewer, a, now, ["banner"]);
          if (!r.sees) continue;
          batch.set(V.seenRef(a.id, uid), r.cycleKey ? { cycles: { [r.cycleKey]: { bannerViews: inc } } } : { bannerViews: inc }, { merge: true });
          counted += 1;
        }
        if (counted) await batch.commit();
        return ok(res, { kind: "bannerView", counted });
      }

      const snap = await V.annCol().doc(input.id).get();
      const a = snap && snap.exists ? { ...(snap.data() || {}), id: input.id } : null;
      const r = await seesOf(viewer, a, now, logic.ANNOUNCEMENT_CHANNELS);
      if (!r.sees) return sendDeny(res, deny(404, "announcement_not_found", "ไม่พบประกาศนี้"));
      const field = FIELD[input.kind];
      const ref = V.seenRef(a.id, uid);
      const out = await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        const prev = cur && cur.exists ? cur.data() || {} : {};
        if (a.kind === "evergreen") {
          const cs = logic.announcementCycleSeen(prev, r.cycleKey) || {};
          if (stamped(cs[field])) return { already: true };
          tx.set(ref, { cycles: { [r.cycleKey]: { [field]: now } }, ...(stamped(prev[field]) ? {} : { [field]: now }) }, { merge: true });
          return { already: false };
        }
        if (stamped(prev[field])) return { already: true };
        tx.set(ref, { [field]: now }, { merge: true });
        return { already: false };
      });
      return ok(res, { id: a.id, kind: input.kind, already: out.already, cycleKey: r.cycleKey });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { seen };
