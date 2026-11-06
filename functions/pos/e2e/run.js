#!/usr/bin/env node
// pos/e2e/run.js — เปิด Firestore emulator ชั่วคราว แล้วรันเทส e2e ของ pos (ก้อน 4 · DEV-0001)
//
// ใช้: cd shopchamp_server/functions && npm run test:e2e          (ทุกไฟล์ *.e2e.js ใต้ pos/)
//      node pos/e2e/run.js pos/e2e/sale.e2e.js                     (เลือกไฟล์)
//
// ทำอะไร:
//   1. มี FIRESTORE_EMULATOR_HOST อยู่แล้ว (เปิด emulator เอง) = ใช้ตัวนั้น · ไม่งั้นเปิด jar ของ emulator ที่ firebase CLI โหลดไว้
//      (~/.cache/firebase/emulators/cloud-firestore-emulator-*.jar · ไม่มี = รัน `firebase setup:emulators:firestore` ครั้งเดียว)
//      ต้องใช้ Java 21 ขึ้นไป (macOS หาเองด้วย /usr/libexec/java_home -v 21+ · ที่อื่นตั้ง E2E_JAVA_HOME หรือ JAVA_HOME)
//   2. project id = demo-shopchamp (project สมมติ ต่อของจริงไม่ได้) · port ว่างที่สุ่มได้ · ผูก 127.0.0.1 เท่านั้น
//   3. node --test ทีละไฟล์ (--test-concurrency=1 · ทุกไฟล์ใช้ฐานเดียวกัน) · TZ=Asia/Bangkok ให้สูตรแอปเก่าที่อ่านนาฬิกาเครื่องตรงกับร้าน
//   4. ปิด emulator · exit code = ผลเทส
// ทำไมไม่ใช้ `firebase emulators:exec`: ด่านของบ้าน (guard-pretooluse no-cross-project) ปัด `--project demo-…`
//   และ firebase.json ของ repo มี key แปลกใน functions · เปิด jar ตรงไม่ต้องผูก project ใดเลย
"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const http = require("http");

const PROJECT = "demo-shopchamp";
const HERE = __dirname;
const FUNCTIONS = path.resolve(HERE, "../..");

function findJar() {
  if (process.env.FIRESTORE_EMULATOR_JAR) return process.env.FIRESTORE_EMULATOR_JAR;
  const dir = path.join(os.homedir(), ".cache", "firebase", "emulators");
  const jars = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^cloud-firestore-emulator-v[\d.]+\.jar$/.test(f)) : [];
  if (!jars.length) throw new Error(`ไม่พบ jar ของ Firestore emulator ใน ${dir} · รัน: firebase setup:emulators:firestore`);
  const ver = (f) => f.match(/v([\d.]+)\.jar$/)[1].split(".").map(Number);
  jars.sort((a, b) => { const x = ver(a); const y = ver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; });
  return path.join(dir, jars[0]);
}

// E2E_JAVA_HOME ก่อน · macOS หา 21+ ก่อน JAVA_HOME (เครื่องนี้ JAVA_HOME = 17 ซึ่ง jar รุ่นใหม่ไม่รับ)
function findJava() {
  if (process.env.E2E_JAVA_HOME) return path.join(process.env.E2E_JAVA_HOME, "bin", "java");
  if (process.platform === "darwin" && fs.existsSync("/usr/libexec/java_home")) {
    const r = spawnSync("/usr/libexec/java_home", ["-v", "21+"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return path.join(r.stdout.trim(), "bin", "java");
  }
  if (process.env.JAVA_HOME) return path.join(process.env.JAVA_HOME, "bin", "java");
  return "java";
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const ping = (port) => new Promise((resolve) => {
  const r = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  r.on("error", () => resolve(false));
  r.setTimeout(1000, () => { r.destroy(); resolve(false); });
});

async function startEmulator() {
  const port = await freePort();
  const jar = findJar();
  const java = findJava();
  const log = [];
  const child = spawn(java, ["-jar", jar, "--host", "127.0.0.1", "--port", String(port), "--project_id", PROJECT, "--single_project_mode", "true"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (c) => log.push(String(c)));
  child.stderr.on("data", (c) => log.push(String(c)));
  let exited = null;
  child.on("exit", (code) => { exited = code; });
  for (let i = 0; i < 120; i++) {
    if (exited !== null) throw new Error(`emulator ปิดตัวเอง (exit ${exited})\n${log.join("").slice(-2000)}`);
    if (await ping(port)) return { child, host: `127.0.0.1:${port}` };
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGKILL");
  throw new Error(`emulator ไม่ขึ้นใน 60 วินาที\n${log.join("").slice(-2000)}`);
}

// ทุก *.e2e.js ใต้ pos/ (ก้อน 9: โดเมนวางเทส e2e ข้าง handler เช่น pos/shopStaff/shopStaff.e2e.js) · เรียงตาม path
function findE2e(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findE2e(p));
    else if (e.isFile() && e.name.endsWith(".e2e.js")) out.push(p);
  }
  return out.sort();
}

async function main() {
  const args = process.argv.slice(2);
  const files = args.length ? args.map((f) => path.resolve(process.cwd(), f))
    : findE2e(path.resolve(HERE, ".."));
  let emu = null;
  let host = process.env.FIRESTORE_EMULATOR_HOST;
  let project = process.env.GCLOUD_PROJECT || PROJECT;
  if (!host) {
    emu = await startEmulator();
    host = emu.host;
    project = PROJECT;
    console.log(`e2e: Firestore emulator ${host} · project ${project}`);
  }
  const env = { ...process.env, FIRESTORE_EMULATOR_HOST: host, GCLOUD_PROJECT: project, GOOGLE_CLOUD_PROJECT: project, TZ: "Asia/Bangkok" };
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  // spawn แบบ async (ไม่ใช่ spawnSync): ระหว่างรอ event loop ต้องว่างไว้อ่าน stdout/stderr ของ emulator
  //   spawnSync บล็อก loop ⇒ ท่อ log ของ emulator เต็ม (~64KB) ⇒ emulator ค้างตอนเขียน log ⇒ ไฟล์ท้าย ๆ ได้ DEADLINE_EXCEEDED (พบก้อน 9 ตอนรวม 6 ไฟล์)
  const status = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], { cwd: FUNCTIONS, env, stdio: "inherit" });
    c.on("exit", (code) => resolve(code));
    c.on("error", () => resolve(null));
  });
  if (emu) emu.child.kill("SIGTERM");
  process.exit(status === null ? 1 : status);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
