// pos/announcement/feed — แอปอ่านประกาศถึงร้าน (DEV-0003 0e · Pack สั่ง 2026-11-11)
//
// สัญญา: shopchamp-center/api/announcement.feed.yaml · route POST /pos/announcement/feed (auth shop · อ่านอย่างเดียว · ไม่เขียนฐาน)
// คำขอ: AnnouncementFeedRequest {shopId} · คน = req.shopAccess.uid (ไม่รับจาก body) · watcher อ่านได้ แต่ไม่มีแถวในร้าน = ไม่เห็นประกาศ
// คำตอบ: {banners, popups, inbox, unreadCount} · ข้อความแทนตัวแปรแล้ว ({ชื่อร้าน} {แพ็กเกจ} {วันหมดอายุ} {เหลือวัน})
//   ถาวรมาก่อน (ใหม่สุดก่อน) แล้วชั่วคราว (startAt ใหม่สุดก่อน) · ถาวรส่ง cycleKey ให้แอปส่งกลับตอน seen
//   unreadCount = ในกล่องข่าวที่ยังไม่มี readAt (ถาวรดูของรอบ)
// ใครเห็น/ช่องไหน = @shopchamp/logic (announcementMatchesShop · announcementMatchesPerson · announcementEvergreenMatch · announcementChannelVisible)
// แอปเก่า 3.12 ไม่เรียกเส้นนี้ (เห็นประกาศตั้งแต่แอปใหม่ 5.00)
"use strict";

const logic = require("@shopchamp/logic");
const { AnnouncementFeedRequest } = require("@shopchamp/schema");
const { ok, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess } = require("../_shared/auth");
const V = require("./_viewer");

const isoOf = (t) => { const ms = logic.toMillis(t); return ms === null ? null : new Date(ms).toISOString(); };
const str = (v) => (typeof v === "string" ? v : "");

/** รูปที่ส่งให้แอป (whitelist · ไม่ส่ง audience/createdBy) */
function viewOf(a, vars, seen, cycleKey) {
  return {
    id: a.id,
    kind: a.kind,
    title: logic.announcementFillText(str(a.title), vars),
    body: logic.announcementFillText(str(a.body), vars),
    images: Array.isArray(a.images) ? a.images.filter((u) => typeof u === "string" && u !== "") : [],
    buttonText: logic.announcementFillText(str(a.buttonText), vars),
    buttonUrl: str(a.buttonUrl),
    bannerSticky: a.bannerSticky === true,
    startAt: a.kind === "evergreen" ? null : isoOf(a.startAt),
    endAt: a.kind === "evergreen" ? null : isoOf(a.endAt),
    readAt: seen ? isoOf(seen.readAt) : null,
    cycleKey: cycleKey || null,
  };
}

const sortKey = (a) => (a.kind === "evergreen" ? [0, -(logic.toMillis(a.createdAt) || 0)] : [1, -(logic.toMillis(a.startAt) || 0)]);

function feed(deps) {
  return async function handler(req, res) {
    const input = parseOr400(AnnouncementFeedRequest, req && req.body, res);
    if (!input) return undefined;
    const a0 = callerAccess(req, input.shopId, { read: true });
    if (!a0.ok) return sendDeny(res, a0);
    try {
      const now = await readNow(deps);
      const viewer = await V.viewerOf(a0.access.shopId, a0.access.uid, now);
      const all = await V.candidates(now);
      const mine = [];
      for (const a of all) {
        if (!viewer.matches(a)) continue;
        if (a.kind === "evergreen") {
          const m = await viewer.evergreen(a);
          if (m.match) mine.push({ a, cycleKey: m.cycleKey, vars: { ...m.vars } });
        } else if (a.kind === "campaign") mine.push({ a, cycleKey: null, vars: viewer.vars });
      }
      mine.sort((x, y) => { const p = sortKey(x.a), q = sortKey(y.a); return p[0] - q[0] || p[1] - q[1]; });
      const seenMap = await V.readSeen(mine.map((m) => m.a), a0.access.uid);
      const out = { banners: [], popups: [], inbox: [], unreadCount: 0 };
      for (const { a, cycleKey, vars } of mine) {
        const doc = seenMap.get(a.id) || null;
        const seen = a.kind === "evergreen" ? logic.announcementCycleSeen(doc, cycleKey) : doc;
        const view = () => viewOf(a, vars, seen, cycleKey);
        if (logic.announcementChannelVisible(a, "banner", doc, now, cycleKey)) out.banners.push(view());
        if (logic.announcementChannelVisible(a, "popup", doc, now, cycleKey)) out.popups.push(view());
        if (logic.announcementChannelVisible(a, "inbox", doc, now, cycleKey)) {
          out.inbox.push(view());
          if (!(seen && logic.toMillis(seen.readAt) !== null)) out.unreadCount += 1;
        }
      }
      return ok(res, out);
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { feed, viewOf };
