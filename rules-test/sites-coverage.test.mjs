// sites-coverage.test.mjs — ทุกบรรทัด collection( ของ client รุ่นเดิมต้องมีแถวใน sites.mjs และแถวนั้นชี้เทสที่มีจริง
// (measure-the-absent: ถ้ามีจุดเรียกใหม่ที่ตารางไม่รู้จัก = แดง · หา repo ต้นทางไม่เจอ = แดง ไม่ข้ามเงียบ)
// ตั้งที่อยู่ repo เองได้: SITES_APP_REPO (git · อ่าน ref main3) · SITES_OWN_DIR · SITES_FR_DIR · ข้ามทั้งไฟล์: SITES_SKIP=1
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SITES } from "./sites.mjs";
import { SHOP_SCENARIOS, OTHER_SCENARIOS } from "./scenarios.mjs";

const APP = process.env.SITES_APP_REPO || join(import.meta.dirname, "..", "..", "shopchamp_app");
const OWN = process.env.SITES_OWN_DIR || join(homedir(), "Desktop/Shopchamp/shopchamp_WebOwner");
const FRD = process.env.SITES_FR_DIR || join(homedir(), "Desktop/Shopchamp/shopchamp_Franchise");
const CALL = /collection(Group)?\(/;

function appSites() {
  const out = execFileSync("git", ["-C", APP, "grep", "-n", "-E", "collection(Group)?\\(", "main3", "--", "src"], { encoding: "utf8" });
  return out.trim().split("\n").map((l) => { const m = l.match(/^main3:([^:]+):(\d+):/); return `${m[1]}:${m[2]}`; });
}
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules") walk(p, out); } else if (/\.(js|jsx|ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}
function webSites(root) {
  const res = [];
  for (const f of walk(join(root, "src"))) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => { if (CALL.test(line)) res.push(`${f.slice(root.length + 1)}:${i + 1}`); });
  }
  return res;
}

const skip = process.env.SITES_SKIP === "1";
test("ทุกจุดเรียกของแอปเก่า main3 อยู่ในตาราง", { skip }, () => {
  assert.ok(existsSync(APP), `ไม่พบ repo แอป ${APP} (ตั้ง SITES_APP_REPO)`);
  const want = new Set(appSites()); const have = new Set(SITES.filter((s) => s[0] === "app").map((s) => s[1]));
  assert.deepEqual([...want].filter((x) => !have.has(x)), [], "จุดเรียกที่ตารางไม่มี");
  assert.deepEqual([...have].filter((x) => !want.has(x)), [], "แถวในตารางที่ไม่มีในโค้ดแล้ว");
  assert.equal(want.size, 206, "census-firestore.md นับไว้ 206 จุด");
});
for (const [tag, root] of [["own", OWN], ["fr", FRD]]) {
  test(`ทุกจุดเรียกของเว็บ ${tag} อยู่ในตาราง`, { skip }, () => {
    assert.ok(existsSync(root), `ไม่พบ ${root}`);
    const want = new Set(webSites(root)); const have = new Set(SITES.filter((s) => s[0] === tag).map((s) => s[1]));
    assert.deepEqual([...want].filter((x) => !have.has(x)), [], "จุดเรียกที่ตารางไม่มี");
    assert.deepEqual([...have].filter((x) => !want.has(x)), [], "แถวในตารางที่ไม่มีในโค้ดแล้ว");
  });
}
test("ทุกแถวชี้เทสที่มีจริง", () => {
  const bad = SITES.filter(([, , t]) => {
    if (t === "NONE" || t.startsWith("DENY:")) return false;
    if (t.startsWith("S:")) return !SHOP_SCENARIOS[t.slice(2)];
    if (t.startsWith("O:")) return !OTHER_SCENARIOS[t.slice(2).split("@")[0]];
    return true;
  });
  assert.deepEqual(bad, []);
});
test("แถว NONE เป็นคอมเมนต์จริง (ไม่ใช่การเรียกที่ถูกเหมาว่าไม่มี)", { skip }, () => {
  const notComment = [];
  for (const [tag, site, t] of SITES) {
    if (t !== "NONE") continue;
    const [file, line] = [site.slice(0, site.lastIndexOf(":")), Number(site.slice(site.lastIndexOf(":") + 1))];
    const text = tag === "app"
      ? execFileSync("git", ["-C", APP, "show", `main3:${file}`], { encoding: "utf8" })
      : readFileSync(join(tag === "own" ? OWN : FRD, file), "utf8");
    if (!/^\s*\/\//.test(text.split("\n")[line - 1])) notComment.push(`${tag}:${site}`);
  }
  assert.deepEqual(notComment, []);
});
