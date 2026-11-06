#!/usr/bin/env node
// rules-test/run.mjs — เปิด Firestore emulator ชั่วคราวแล้วรันเทส rules (DEV-0001 ก้อน 6)
//
// ใช้: cd shopchamp_server/rules-test && npm install && npm test
//      node run.mjs firestore.sites.test.mjs          (เลือกไฟล์)
//      RULES_FILE=/path/อื่น.rules npm test            (รันชุดเดียวกันกับ rules ตัวอื่น เช่นตัวที่ live อยู่ ⇒ เทียบ 2 ทิศ)
//
// เปิด jar ของ emulator ตรงแบบ functions/pos/e2e/run.js (ด่านของบ้านปัด `firebase emulators:exec --project demo-…`)
// ต้องมี ~/.cache/firebase/emulators/cloud-firestore-emulator-*.jar และ Java 21 ขึ้นไป
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function findJar() {
  if (process.env.FIRESTORE_EMULATOR_JAR) return process.env.FIRESTORE_EMULATOR_JAR;
  const dir = path.join(os.homedir(), ".cache", "firebase", "emulators");
  const jars = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^cloud-firestore-emulator-v[\d.]+\.jar$/.test(f)) : [];
  if (!jars.length) throw new Error(`ไม่พบ jar ของ Firestore emulator ใน ${dir} · รัน: firebase setup:emulators:firestore`);
  const ver = (f) => f.match(/v([\d.]+)\.jar$/)[1].split(".").map(Number);
  jars.sort((a, b) => { const x = ver(a); const y = ver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; });
  return path.join(dir, jars[0]);
}

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
  const log = [];
  const child = spawn(findJava(), ["-jar", findJar(), "--host", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (c) => log.push(String(c)));
  child.stderr.on("data", (c) => log.push(String(c)));
  let exited = null;
  child.on("exit", (code) => { exited = code; });
  for (let i = 0; i < 120; i++) {
    if (exited !== null) throw new Error(`emulator ปิดตัวเอง (exit ${exited})\n${log.join("").slice(-2000)}`);
    if (await ping(port)) return { child, port };
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGKILL");
  throw new Error(`emulator ไม่ขึ้นใน 60 วินาที\n${log.join("").slice(-2000)}`);
}

const args = process.argv.slice(2);
const files = args.length ? args.map((f) => path.resolve(process.cwd(), f))
  : fs.readdirSync(HERE).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => path.join(HERE, f));
const emu = await startEmulator();
console.log(`rules-test: Firestore emulator 127.0.0.1:${emu.port} · rules ${process.env.RULES_FILE || "../firestore.rules"}`);
const env = { ...process.env, FIRESTORE_EMULATOR_HOST: `127.0.0.1:${emu.port}` };
delete env.GOOGLE_APPLICATION_CREDENTIALS;
const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], { cwd: HERE, env, stdio: "inherit" });
emu.child.kill("SIGTERM");
process.exit(r.status === null ? 1 : r.status);
