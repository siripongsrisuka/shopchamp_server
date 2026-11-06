// pos/gateway/beam/beamPaymentMethods.js — รูปของ `paymentMethod` ต่อวิธีจ่ายที่ Beam รับ (ความจริงชุดเดียว) · ก้อน 7 · DEV-0001
//
// ยกจากพี่น้องตามตัว · ตรวจกับ Beam OpenAPI (docs.beamcheckout.com/v1/api) แล้ว
// ชื่อ key แบบ camel ที่ Beam ต้องการ (เช่น `weChatPay` ตัว C ใหญ่) ต้องมีที่นี่ที่เดียว — สองสำเนา = เพี้ยนเงียบแล้ว Beam ปัด 400
"use strict";

// BoltIntentCardInstallments บังคับทั้ง 2 ช่อง: installmentPeriod (3|4|6|10 เดือน) + issuerGroup (ชื่อธนาคารแบบ PascalCase)
//   ส่งแค่ installmentPeriod = Beam 400 "issuerGroup is a required field" (เกิดจริงที่พี่น้อง)
const CARD_INSTALLMENT_PERIODS = [3, 4, 6, 10];
const CARD_INSTALLMENT_ISSUER_GROUPS = [
  "BangkokBank",
  "CIMBThaiBank",
  "KasikornBank",
  "KrungsriBank",
  "KrungsriFirstChoice",
  "KrungthaiBank",
  "SiamCommercialBank",
  "TMBThanachartBank",
  "UnitedOverseasBank",
  "Ungrouped",
  "Unknown",
];
const DEFAULT_INSTALLMENT_PERIOD = 3;
const DEFAULT_INSTALLMENT_ISSUER_GROUP = "KasikornBank";

// ตัวสร้าง paymentMethod ต่อชนิด · SPAY_LATER ไม่รองรับโดยตั้งใจ (ผู้เรียกตอบ unsupported_payment_method)
const PAYMENT_METHOD_FACTORIES = {
  QR_PROMPT_PAY: () => ({ paymentMethodType: "QR_PROMPT_PAY", qrPromptPay: {} }),
  CARD: () => ({ paymentMethodType: "CARD", card: {} }),
  CARD_INSTALLMENTS: (opts = {}) => ({
    paymentMethodType: "CARD_INSTALLMENTS",
    cardInstallments: {
      installmentPeriod: typeof opts.installmentPeriod === "number" ? opts.installmentPeriod : DEFAULT_INSTALLMENT_PERIOD,
      issuerGroup: opts.issuerGroup || DEFAULT_INSTALLMENT_ISSUER_GROUP,
    },
  }),
  ALIPAY: () => ({ paymentMethodType: "ALIPAY", alipay: {} }),
  ALIPAY_PLUS: () => ({ paymentMethodType: "ALIPAY_PLUS", alipayPlus: {} }),
  LINE_PAY: () => ({ paymentMethodType: "LINE_PAY", linePay: {} }),
  SHOPEE_PAY: () => ({ paymentMethodType: "SHOPEE_PAY", shopeePay: {} }),
  TRUE_MONEY: () => ({ paymentMethodType: "TRUE_MONEY", trueMoney: {} }),
  WECHAT_PAY: () => ({ paymentMethodType: "WECHAT_PAY", weChatPay: {} }),
};

const SUPPORTED_PAYMENT_METHODS = Object.keys(PAYMENT_METHOD_FACTORIES);

module.exports = {
  PAYMENT_METHOD_FACTORIES,
  SUPPORTED_PAYMENT_METHODS,
  CARD_INSTALLMENT_PERIODS,
  CARD_INSTALLMENT_ISSUER_GROUPS,
  DEFAULT_INSTALLMENT_PERIOD,
  DEFAULT_INSTALLMENT_ISSUER_GROUP,
};
