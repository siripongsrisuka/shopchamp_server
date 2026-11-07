// pos/_shared/push/onesignalPipe.js — ท่อที่ 2 ช่วงเปลี่ยนผ่าน: ส่งข้อความเดียวกันผ่าน OneSignal ให้เครื่องที่ยังเป็นแอปเก่า
//   (DEV-0001 push · Pack เลือกทาง 1 "2 ท่อ" 2026-11-07 · `push-pattern-from-sibling.md` §3.4) · จะยกเลิก OneSignal ใน ~1 เดือน
//   🗑️ ไฟล์นี้ลบทิ้งได้ใน commit เดียว: ลบไฟล์ + บรรทัด require/เรียก ใน send.js + onesignalPipe.test.js
//
// รูปคำขอ = รูปเดียวกับ legacy `functions/apis/onesignal.js` /sendPush (อ่านอย่างเดียว ไม่แก้ legacy)
//   + filter tag แบบที่แอปเก่าใช้ (main3 `src/api/onesignal.js`): pushByShopFilter {shopId} · pushByTwoFilter {id AND shopId} · pushByIdFilter {id}
//   หลายคน = ยิง 1 ครั้งต่อคนแบบแอปเก่า (filter ไม่เกิน 2 ตัว)
//   tag shopId ของแอปเก่า = field `shop.shopId` (main3 `LoadingScreen.js:196` ส่ง shopInfo.shopId) ไม่ใช่ doc id ⇒ อ่าน doc ร้านหาค่า (ไม่มี field = doc id)
// กุญแจ: env `ONESIGNAL_REST_API_KEY` เท่านั้น (ยังไม่มีใน Secret Manager · ยังไม่ผูกใน workloads.js)
//   ไม่มีค่า = ข้ามท่อนี้ · log 1 บรรทัดต่อโปรเซส · ไม่ทำให้คำขอพัง · app id = env `ONESIGNAL_APP_ID` หรือค่าของแอป (ค่าสาธารณะที่อยู่ในแอปอยู่แล้ว)
// 🔒 ไม่ throw · ไม่ส่งแบบไม่มี filter (legacy ไม่มี filter = ส่งทุกเครื่องทุกร้าน ⇒ ที่นี่ปัดเสมอ)
"use strict";

const ENDPOINT = "https://onesignal.com/api/v1/notifications";
const DEFAULT_APP_ID = "c333d569-ae68-4ea3-a46d-e1783f4e1f6a"; // APP/src/api/onesignal.js:60 (แอปเก่า)
const URGENT_CHANNEL = "30487017-ba42-4bc2-b2a7-9bf675015b02"; // androidChannelIds.urgent ของแอปเก่า
const SMALL_ICON = "ic_stat_onesignal_default";

let warnedNoKey = false;
const tag = (key, value) => ({ field: "tag", key, relation: "=", value });
const cleanIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && x !== ""))];

/** legacyShopIdOf(docId) — ค่า tag shopId ที่แอปเก่าติด = field shop.shopId · อ่านไม่ได้/ไม่มี = doc id */
async function legacyShopIdOf(docId, deps) {
  try {
    const db = deps.db || require("../../../firebase").db;
    const snap = await db.collection("shop").doc(docId).get();
    const d = snap && snap.exists ? snap.data() || {} : {};
    return typeof d.shopId === "string" && d.shopId !== "" ? d.shopId : docId;
  } catch (_) {
    return docId;
  }
}

/** filterSets(to, legacyShopId) → array ของ filters (1 ชุด = 1 คำขอ) · รูปผิด/ว่าง = [] */
function filterSets(to, legacyShopId) {
  if (!to || typeof to !== "object") return [];
  if (to.kind === "shop") return legacyShopId ? [[tag("shopId", legacyShopId)]] : [];
  if (to.kind === "staff") return legacyShopId ? cleanIds(to.ids).map((id) => [tag("id", id), { operator: "AND" }, tag("shopId", legacyShopId)]) : [];
  if (to.kind === "people") return cleanIds(to.ids).map((id) => [tag("id", id)]);
  return [];
}

/** bodyOf(message, filters, appId) — รูปเดียวกับ legacy /sendPush */
function bodyOf(message, filters, appId) {
  return {
    headings: { en: String(message.heading == null ? "" : message.heading) },
    contents: { en: String(message.content == null ? "" : message.content) },
    data: message.data && typeof message.data === "object" ? message.data : {},
    small_icon: SMALL_ICON,
    name: "API_CAMPAIGN_NAME",
    filters,
    android_channel_id: URGENT_CHANNEL,
    priority: 10,
    enable_frequency_cap: false,
    app_id: appId,
  };
}

/** sendOneSignal(message, deps) → {skipped?, requests, ok, failed} */
async function sendOneSignal(message, deps = {}) {
  const out = { requests: 0, ok: 0, failed: 0 };
  try {
    const env = deps.env || process.env;
    const key = env.ONESIGNAL_REST_API_KEY;
    const log = deps.log || console;
    if (!key) {
      if (!warnedNoKey) { warnedNoKey = true; log.info("push onesignal skipped: ไม่มี ONESIGNAL_REST_API_KEY"); }
      return { ...out, skipped: "no_key" };
    }
    if (deps.dryRun === true || env.PUSH_DRY_RUN === "1") return { ...out, skipped: "dry_run" }; // OneSignal ไม่มีโหมดตรวจอย่างเดียว ⇒ dryRun = ไม่ยิง
    if (!message || !message.to) return { ...out, skipped: "no_target" };
    const needShop = message.to.kind === "shop" || message.to.kind === "staff";
    const legacyShopId = needShop ? (typeof message.to.shopId === "string" && message.to.shopId ? await legacyShopIdOf(message.to.shopId, deps) : "") : "";
    const sets = filterSets(message.to, legacyShopId);
    if (!sets.length) return { ...out, skipped: "no_target" };
    const appId = env.ONESIGNAL_APP_ID || DEFAULT_APP_ID;
    const doFetch = deps.fetch || fetch;
    for (const filters of sets) {
      out.requests += 1;
      try {
        const r = await doFetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8", Authorization: "Basic " + key },
          body: JSON.stringify(bodyOf(message, filters, appId)),
        });
        if (r && r.status === 200) out.ok += 1;
        else out.failed += 1;
      } catch (_) {
        out.failed += 1;
      }
    }
    log.info(`push onesignal ${message.to.kind} requests=${out.requests} ok=${out.ok} failed=${out.failed}`);
    return out;
  } catch (e) {
    return { ...out, error: (e && e.message) || String(e) };
  }
}

module.exports = { sendOneSignal, filterSets, bodyOf, legacyShopIdOf, ENDPOINT, DEFAULT_APP_ID, URGENT_CHANNEL };
