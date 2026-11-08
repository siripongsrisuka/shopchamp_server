// pos/gateway/stations — เจ้าของผูก/ถอดเครื่อง NTT EDC กับจุดคิดเงิน (ก้อน 7 · DEV-0001 · ของใหม่ ไม่มีในพี่น้อง)
//
// สัญญา: shopchamp-center/api/payment.stationEdcSet.yaml · route POST /pos_gateway/payment/station-edc-set (ยังไม่ผูก index.js)
// ที่มา: Pack เลือก 2026-11-06 "EDC = NTT เท่านั้น ผูกรายจุดคิดเงิน" · พี่น้องเก็บ host/port ของเครื่องเป็นค่าเชื่อมต่อของร้าน (1 ร้าน 1 เครื่อง)
//   ⇒ ร้านที่มีหลายจุดคิดเงินแต่ละจุดต้องคุยกับเครื่องของตัวเอง · เก็บที่ `gatewayStations/{shopId}` (rules ก้อน 6 ปิด client)
// รูปเอกสาร: { stations: { [stationId]: {name, providerId:'ntt-edc', device:{ip, port, name?}, updatedAt, updatedBy, byAdmin?, adminUid?} }, updatedAt, updatedBy }
// รูป: factory (deps) => handler(req, res) · deps: now
//
// ลำดับ:
//   ① callerAccess → 401/403   ② ไม่ใช่เจ้าของ (ทีมงานได้ role owner) → 403 owner_required   ③ Zod PaymentStationEdcSetRequest → 400
//   ③' device ≠ null (ผูก/แก้) + ไม่มีแพ็กเกจ Payment Gateway = 403 package_required ไม่เขียน (packageGate.js)
//      device = null (ถอด) ไม่ติดด่าน — ถอดเครื่องได้เสมอเหมือน unpair
//   ④ transaction อ่านก่อนเขียน:
//      device = null → ถอดจุดนั้นออก (ไม่มีอยู่แล้ว = 200 removed:false ไม่เขียน)
//      device = {ip, port, name?} → ผูก/แก้ · จุดใหม่เมื่อมีครบ 20 จุดแล้ว = 409 too_many_stations ไม่เขียน
//      stationName ไม่ส่ง = ใช้ชื่อเดิม (ไม่มีชื่อเดิม = stationId)
//   คำตอบ 200 {stationId, device, removed?, stationCount}
"use strict";

const { PaymentStationEdcSetRequest } = require("@shopchamp/schema");
const { ok, fail, deny, sendDeny, parseOr400, internalError } = require("../_shared/respond");
const { readNow } = require("../_shared/deps");
const { callerAccess, isOwner, adminTrail, adminFlag } = require("../_shared/auth");
const CS = require("./credStore");
const PG = require("./packageGate");

const MAX_STATIONS = 20;
const EDC_PROVIDER_ID = "ntt-edc";

const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

function stationEdcSet(deps) {
  return async function handler(req, res) {
    const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const gate = callerAccess(req, body.shopId);
    if (!gate.ok) return sendDeny(res, gate);
    const access = gate.access;
    if (!isOwner(access)) return sendDeny(res, deny(403, "owner_required"));
    const input = parseOr400(PaymentStationEdcSetRequest, body, res);
    if (!input) return undefined;

    try {
      const now = await readNow(deps);
      const { db } = require("../../firebase");
      if (input.device !== null && !(await PG.passesPackage({ db, access, now, res }))) return undefined;
      const ref = CS.stationsRef(db, access.shopId);
      const trail = adminTrail(access);
      const sid = input.stationId;

      const out = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const cur = asObj(snap && snap.exists ? asObj(snap.data()).stations : {});
        const stations = { ...cur };
        const had = Object.prototype.hasOwnProperty.call(stations, sid);
        if (input.device === null) {
          if (!had) return { kind: "noop", count: Object.keys(stations).length };
          delete stations[sid];
        } else {
          if (!had && Object.keys(stations).length >= MAX_STATIONS) return { kind: "too_many" };
          const device = { ip: input.device.ip, port: input.device.port };
          if (typeof input.device.name === "string" && input.device.name.trim()) device.name = input.device.name.trim();
          const prevName = had && typeof asObj(stations[sid]).name === "string" ? stations[sid].name : null;
          const name = typeof input.stationName === "string" && input.stationName.trim() ? input.stationName.trim() : prevName || sid;
          stations[sid] = { name, providerId: EDC_PROVIDER_ID, device, updatedAt: now, updatedBy: access.uid, ...trail };
        }
        // เขียนทั้ง map (ถอดจุด = ไม่มี key) · doc นี้เก็บแค่ stations ⇒ set แทนที่ได้
        tx.set(ref, { stations, updatedAt: now, updatedBy: access.uid, ...trail });
        return { kind: input.device === null ? "removed" : "set", count: Object.keys(stations).length, device: input.device === null ? null : stations[sid].device };
      });

      if (out.kind === "too_many") {
        return fail(res, 409, "too_many_stations", `ผูกเครื่องได้สูงสุด ${MAX_STATIONS} จุดคิดเงินต่อร้าน`, { max: MAX_STATIONS });
      }
      if (out.kind === "noop") return ok(res, { stationId: sid, device: null, removed: false, stationCount: out.count, ...adminFlag(access) });
      if (out.kind === "removed") return ok(res, { stationId: sid, device: null, removed: true, stationCount: out.count, ...adminFlag(access) });
      return ok(res, { stationId: sid, device: out.device, stationCount: out.count, ...adminFlag(access) });
    } catch (e) {
      return internalError(res, e);
    }
  };
}

module.exports = { stationEdcSet, MAX_STATIONS };
