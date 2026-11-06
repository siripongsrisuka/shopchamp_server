// pos/gateway/providers/ntt-edc — NTT DATA LinkPOS (เครื่อง EDC ในร้าน · ยกจากบ้านพี่น้อง ก้อน 7 · DEV-0001)
//
// เจ้านี้ไม่มี cloud ให้เซิร์ฟเวอร์ยิงเลย · แอปคุยกับเครื่อง EDC ตรงผ่าน TCP ใน LAN ร้าน (พอร์ต 8020)
// ⇒ ไฟล์นี้ = คำประกาศ spec + ตัวช่วยล้วน (ไม่มี db · ไม่มี network) ให้ handler deviceSaleRecord / stationEdcSet ใช้
// cite = เอกสาร LinkPOS v1.8 (อ้างเป็น `linkpos:<บรรทัด>`)
//
// ⚠️ คนละผลิตภัณฑ์กับ `ntt-h2h` แม้ชื่อเจ้าเดียวกัน:
//   h2h = เซิร์ฟเวอร์ยิง cloud · มี TID+รหัสผ่าน · รหัสกระเป๋าตัวอักษรเดี่ยว · คืน QR payload · รู้ผลทาง webhook/inquiry
//   edc = แอปยิงเครื่อง · ไม่มี credential เลย (linkpos:251-254) · trade_type คำเต็ม · QR ขึ้นบนจอเครื่องเอง · รู้ผลบน socket เดิม
// ❌ ไม่ export createQR / inquiry / testConnection / checkChannels โดยเจตนา — เซิร์ฟเวอร์ทำแทนไม่ได้
//    ทะเบียนบังคับฟังก์ชันเหล่านี้เฉพาะ runtime:'server' · ใส่ฟังก์ชันหลอกที่ตอบ error = โกหกทะเบียน
//
// Shopchamp: ที่อยู่เครื่องเก็บรายจุดคิดเงิน (`gatewayStations/{shopId}.stations[stationId].device = {ip, port, name?}`)
//   ไม่ใช่ค่ากลางทั้งร้าน ⇒ ช่องกรอกใน spec ตั้งชื่อตรงกับ device ของจุดคิดเงิน (`ip` · `port`)
"use strict";

const crypto = require("crypto");
const net = require("net");

// linkpos:787-791, 845-851 · แอปฝั่งเครื่องก็ใช้ 8020 · สเปกไม่บอกว่าตั้งเองได้ไหม ⇒ เปิดช่องไว้แบบไม่บังคับ
const DEFAULT_PORT = 8020;

const spec = {
  id: "ntt-edc",
  labelKey: "screens.paymentGateway.provider.ntt-edc.name",
  labelFallback: "NTT DATA (เครื่อง EDC ในร้าน)",
  // แอปเป็นคนคุยกับเครื่อง ⇒ ทะเบียนปัดช่องทางของเจ้านี้ออกจากเส้นขายฝั่ง server (`channel_not_server_runtime`)
  // แต่ยังโผล่ในหน้าตั้งค่าเพราะร้านต้องตั้งค่ามัน
  runtime: "device",
  // เลือกกระเป๋าตอนขาย: กระเป๋าที่เปิดได้ NTT/GHL provision รายเครื่อง (linkpos:128-134) และหลังบ้านตรวจไม่ได้เลย
  // ⇒ ร้านเปิดสวิตช์เดียว แล้วเลือกกระเป๋าตอนขาย · แถวกระเป๋า 12 แถวยังอยู่ครบ (จอตอนขายกางจากรายการนี้)
  channelChoice: "at-bill",

  connection: {
    fields: [
      {
        // IP เครื่อง EDC ใน LAN ร้าน (linkpos:139-171) · ไม่ใช่ความลับ ⇒ ไม่ติด secret
        // ไม่บังคับ: Pack เลือกผูกเครื่องรายจุดคิดเงิน (2026-11-06) ⇒ ที่อยู่จริงอยู่ `gatewayStations/{shopId}` (payment.stationEdcSet)
        //   ช่องระดับร้านนี้เป็นค่าสำรองของร้านที่มีเครื่องเดียว · ไม่กรอกก็เปิดใช้เจ้าได้
        key: "ip",
        labelKey: "screens.paymentGateway.field.ntt-edc.ip",
        labelFallback: "ไอพีเครื่อง EDC",
        required: false,
      },
      {
        // ไม่บังคับ · ไม่กรอก = DEFAULT_PORT (ค่าตั้งต้นฝั่ง server อยู่ที่นี่ที่เดียว)
        key: "port",
        labelKey: "screens.paymentGateway.field.ntt-edc.port",
        labelFallback: "พอร์ต",
        required: false,
        default: DEFAULT_PORT,
      },
    ],
    // device-ping = เซิร์ฟเวอร์กดทดสอบแทนไม่ได้ · ทะเบียนบังคับให้ note เอ่ยชื่อทุกช่องบังคับ
    test: {
      kind: "device-ping",
      note:
        "เซิร์ฟเวอร์ทดสอบแทนไม่ได้เด็ดขาด — เครื่อง EDC อยู่ในวง LAN ของร้าน (ไม่มี cloud/URL ให้ยิงทั้งฉบับสเปก) · " +
        "คนที่ยิงได้คือแอปในร้าน ผ่านคำสั่ง TEST (`transaction_type=TEST` · linkpos:715-726) ไปที่ ip (+ port ถ้ากรอก) · " +
        "ไม่มีช่องบังคับ (ที่อยู่เครื่องรายจุดคิดเงินอยู่ gatewayStations) · ทดสอบ ip — ผ่าน = ต่อ TCP ถึงเครื่องนั้นได้จริงและเครื่องตอบกลับ (response_code=00 + serial_no) · " +
        "❌ ไม่ครอบ: ไม่พิสูจน์ว่าเป็นเครื่องของร้านนี้ (ไม่มี credential ให้ตรวจ) · " +
        "ไม่พิสูจน์ว่าเครื่องเปิดกระเป๋าไหนให้บ้าง (provision รายเครื่อง) · " +
        "ไม่พิสูจน์ว่ารูดขายได้จริง (ต้องมียอดจริงถึงจะรู้)",
    },
  },

  // ตาราง trade_type (linkpos:185-210) ครบ 11 แถว + แถว "ให้เครื่องเลือกเอง" = 12
  // serviceTypes ตามตารางทีละแถว: [] = ไม่มีโหมดสแกนให้เลือก (บัตร) · ไม่ประกาศ = ตัดสินที่เครื่อง (nttEdcAny เท่านั้น)
  //   SHOWQR = ลูกค้าสแกนจอเครื่อง · SCAN = แคชเชียร์สแกนลูกค้า
  // ❌ ไม่ประกาศ qrKind — ไม่มี QR payload ไหลกลับมาถึงเรา
  // lastKnownAvailable:false ทุกแถว — เราวัดเครื่องของร้านจากหลังบ้านไม่ได้ (fail-closed) · ❌ ห้ามเปลี่ยนเป็น true เพราะ "สเปกรองรับ"
  channels: [
    // ไม่ส่ง trade_type = เครื่องกางเมนูให้ลูกค้าเลือกเอง (linkpos:228 REQUIRED=NO + 211-212) · "" = ตั้งใจไม่ส่ง
    { channelId: "nttEdcAny", nameKey: "screens.paymentGateway.channel.nttEdcAny", nameFallback: "ให้เครื่องเลือกเอง", tradeType: "", lastKnownAvailable: false },
    // linkpos:189
    { channelId: "nttEdcCard", nameKey: "screens.paymentGateway.channel.nttEdcCard", nameFallback: "บัตรเครดิต/เดบิต", tradeType: "CARD", serviceTypes: [], lastKnownAvailable: false },
    // linkpos:191
    { channelId: "nttEdcAlipayPlus", nameKey: "screens.paymentGateway.channel.nttEdcAlipayPlus", nameFallback: "Alipay+ (เครื่องรูด NTT)", tradeType: "ALIPAY+", serviceTypes: ["SCAN", "SHOWQR"], lastKnownAvailable: false },
    // linkpos:193 — `WECHATPAYCIL` ไม่ใช่ `WECHAT`
    { channelId: "nttEdcWechat", nameKey: "screens.paymentGateway.channel.nttEdcWechat", nameFallback: "WeChat Pay (เครื่องรูด NTT)", tradeType: "WECHATPAYCIL", serviceTypes: ["SCAN", "SHOWQR"], lastKnownAvailable: false },
    // linkpos:195 — SHOWQR = No
    { channelId: "nttEdcTrueMoney", nameKey: "screens.paymentGateway.channel.nttEdcTrueMoney", nameFallback: "ทรูมันนี่ วอลเล็ท (เครื่องรูด NTT)", tradeType: "TRUEMONEY", serviceTypes: ["SCAN"], lastKnownAvailable: false },
    // linkpos:197
    { channelId: "nttEdcLinePay", nameKey: "screens.paymentGateway.channel.nttEdcLinePay", nameFallback: "ไลน์เพย์ (เครื่องรูด NTT)", tradeType: "LINEPAY", serviceTypes: ["SCAN", "SHOWQR"], lastKnownAvailable: false },
    // linkpos:199 — `SHOPEE` ไม่ใช่ `SHOPEEPAY`
    { channelId: "nttEdcShopeePay", nameKey: "screens.paymentGateway.channel.nttEdcShopeePay", nameFallback: "ShopeePay (เครื่องรูด NTT)", tradeType: "SHOPEE", serviceTypes: ["SCAN", "SHOWQR"], lastKnownAvailable: false },
    // linkpos:201 — มีช่องว่างกลางคำตามที่พิมพ์ในสเปก ยังไม่ได้พิสูจน์กับเครื่องจริง ❌ ห้ามลบช่องว่างเอง
    { channelId: "nttEdcBblQr", nameKey: "screens.paymentGateway.channel.nttEdcBblQr", nameFallback: "คิวอาร์บัตร (Visa/MC/UnionPay)", tradeType: "BBL QRCS", serviceTypes: ["SHOWQR"], lastKnownAvailable: false },
    // linkpos:203
    { channelId: "nttEdcThaiQr", nameKey: "screens.paymentGateway.channel.nttEdcThaiQr", nameFallback: "ไทยคิวอาร์ (เครื่องรูด NTT)", tradeType: "THAIQRCODE", serviceTypes: ["SHOWQR"], lastKnownAvailable: false },
    // linkpos:205
    { channelId: "nttEdcAtome", nameKey: "screens.paymentGateway.channel.nttEdcAtome", nameFallback: "Atome (เครื่องรูด NTT)", tradeType: "ATOME", serviceTypes: ["SHOWQR"], lastKnownAvailable: false },
    // linkpos:207 — SHOWQR = No
    { channelId: "nttEdcSabuyMoney", nameKey: "screens.paymentGateway.channel.nttEdcSabuyMoney", nameFallback: "สบายมันนี่", tradeType: "SABUYMONEY", serviceTypes: ["SCAN"], lastKnownAvailable: false },
    // linkpos:209
    { channelId: "nttEdcMaxMe", nameKey: "screens.paymentGateway.channel.nttEdcMaxMe", nameFallback: "MAX ME (เครื่องรูด NTT)", tradeType: "MAXME", serviceTypes: ["SCAN", "SHOWQR"], lastKnownAvailable: false },
  ],
};

// i18n key ทั้งหมด derive จาก spec (เพิ่มแถวแล้วตามเอง) ให้ฝั่งแอปเอาไปเติมไฟล์แปล
const I18N_KEYS = [spec.labelKey, ...spec.connection.fields.map((f) => f.labelKey), ...spec.channels.map((c) => c.nameKey)];

// channelId → trade_type ที่แอปส่งเข้าเครื่อง ("" = ไม่ส่ง)
const TRADE_TYPES = Object.freeze(Object.fromEntries(spec.channels.map((c) => [c.channelId, c.tradeType])));

// ── ตัวช่วยล้วน (ไม่มี db · ไม่มี network) ─────────────────────────────────────

/** แถวช่องทางของเจ้านี้ · ไม่ใช่ของเจ้านี้ = null */
function channelOf(channelId) {
  if (typeof channelId !== "string") return null;
  return spec.channels.find((c) => c.channelId === channelId) || null;
}

/** trade_type ของช่องทาง · "" = ให้เครื่องเลือกเอง · ไม่รู้จัก = null */
function tradeTypeOf(channelId) {
  const c = channelOf(channelId);
  return c ? c.tradeType : null;
}

/** string ที่มีเนื้อจริงเท่านั้น (trim) · อย่างอื่น = null (fail-closed) */
const cleanStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * คัด device ของจุดคิดเงินจากฐานให้แอป: `{ip, port, name?}` · ip ไม่ใช่ IPv4 = null (ไม่มีเครื่องให้ต่อ)
 * port ไม่ใช่จำนวนเต็ม 1-65535 = DEFAULT_PORT · คัดทีละช่อง ไม่ spread (ของแปลกในฐานไม่หลุดออกจอ)
 */
function deviceConfigOf(device) {
  if (!device || typeof device !== "object" || Array.isArray(device)) return null;
  const ip = cleanStr(device.ip);
  if (!ip || !net.isIPv4(ip)) return null;
  const p = Number(device.port);
  const port = Number.isInteger(p) && p >= 1 && p <= 65535 ? p : DEFAULT_PORT;
  const name = cleanStr(device.name);
  return name ? { ip, port, name: name.slice(0, 64) } : { ip, port };
}

/**
 * ผลจากเครื่องที่แอปส่งมา → ช่องที่เก็บในบิล · ทุกช่อง trim · ว่าง/ไม่ใช่ string = null
 * แผนที่ LinkPOS: invoiceNo = invoice_no · posRefNo = pos_ref_no · tradeType = trade_type
 * (approvalCode/terminalId/merchantId เครื่องส่งกลับมาเอง linkpos:251-254 · ไม่เข้ากุญแจ idempotency)
 */
function saleRecordOf(body) {
  const b = body && typeof body === "object" ? body : {};
  return {
    invoiceNo: cleanStr(b.invoiceNo),
    posRefNo: cleanStr(b.posRefNo),
    tradeType: cleanStr(b.tradeType),
    approvalCode: cleanStr(b.approvalCode),
    terminalId: cleanStr(b.terminalId),
    merchantId: cleanStr(b.merchantId),
  };
}

/** มีเลขอ้างอิงจากเครื่องอย่างน้อย 1 ช่องไหม (ไม่มีเลย = ตามรายการกับธนาคารไม่ได้ ห้ามบันทึก) */
function hasSaleRef(rec) {
  return !!(rec && (cleanStr(rec.invoiceNo) || cleanStr(rec.posRefNo)));
}

/**
 * เลขบิลของผลเครื่อง = `edcsale-` + sha256(`shopId|invoiceNo|posRefNo`) 32 hex แรก
 * ยิงซ้ำกุญแจเดิม = เลขเดิม = ใบเดิม · ช่องที่ไม่ส่ง = สตริงว่าง (คงที่)
 */
function saleReferenceIdOf({ shopId, invoiceNo, posRefNo }) {
  const key = `${shopId}|${cleanStr(invoiceNo) || ""}|${cleanStr(posRefNo) || ""}`;
  return `edcsale-${crypto.createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32)}`;
}

module.exports = {
  spec,
  I18N_KEYS,
  DEFAULT_PORT,
  TRADE_TYPES,
  channelOf,
  tradeTypeOf,
  deviceConfigOf,
  saleRecordOf,
  hasSaleRef,
  saleReferenceIdOf,
};
