#!/usr/bin/env bash
# rollback-firestore-rules.sh — ถอย Firestore rules กลับเป็นตัวก่อนก้อน 6 (มือ Pack เท่านั้น · .claude/rules/deploy.md)
#
# ตัวที่ถอยไป = rules-rollback/firestore.rules.before-chunk6 (สำเนา firestore.rules ของ repo ก่อนก้อน 6 · ตรงกับ
#   shopcham_firebase_nodejs_2022@bc1dad0 ทุกตัวอักษร · "ผู้ login อ่านเขียนได้ทุก doc")
# ⚠️ ก่อน deploy ก้อน 6 ให้ดึงตัวที่ live จริงเก็บไว้ก่อน (ขั้น 0 ใน lanes/dev/source/chunk6-log.md) แล้วถ้าไม่ตรงไฟล์นี้ ให้ใช้ตัวที่ดึงมาแทน
# ทางที่เร็วที่สุดไม่ต้องใช้ terminal: Firebase console › Firestore › Rules › ประวัติ › เลือกตัวก่อนหน้า › Publish
#
# ใช้: bash rules-rollback/rollback-firestore-rules.sh            (ใช้ไฟล์ก่อนก้อน 6)
#      bash rules-rollback/rollback-firestore-rules.sh <ไฟล์อื่น>   (เช่นตัวที่ดึงจาก live ในขั้น 0)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$HERE/firestore.rules.before-chunk6}"
TMP="$(mktemp -d)"
cp "$SRC" "$TMP/firestore.rules"
printf '{"firestore":{"rules":"firestore.rules"}}\n' > "$TMP/firebase.json"
cd "$TMP"
echo "จะ deploy rules จาก $SRC ขึ้น shopcham-24b0b (เฉพาะ firestore:rules)"
firebase deploy --only firestore:rules --project shopcham-24b0b
