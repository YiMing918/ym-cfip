// ym-cfip 测地区结果订阅（v1.33）定向测试（node tests/locmap-fn.mjs）
// stub KV + stub ASSETS（假池子），覆盖：
//   ① POST /save mode=locmap 合法映射 → 200、短码形如 m+9 位 hex、
//      url 以 /s/<码>.txt 结尾、KV 写入带 30 天 expirationTtl、记录里
//      map/created/fmt 对得上；
//   ② 同一份映射重复 POST → 同一个码、locmap 键只写一次（新鲜直返）；
//   ③ 非法 payload 整单 400：内网 IP、坏地区码（不存在/小写/三字母）、
//      空映射、数组、2001 条超限、值不是字符串；
//   ④ GET /s/<m 码>.txt：当前池 ∩ 映射逐条核对——只收映射里的 IP、
//      地区按映射改名、按地区分组、序号按地区从 1 编、映射里有但池
//      子里没有的 IP 不出现、池子里没映射的 IP 不出现；
//   ⑤ fmt 随记录生效：fmt 不含 {来源}/{标签} 时名字里没有方括号标
//      注；含 {标签} 时原样带出（与导出同口径）；
//   ⑥ 不存在的 m 码 → 404 且写明「链接已过期，请重新测地区生成」；
//   ⑦ preset 老路不受影响：mode=preset 存参数 → 10 位 hex 码、GET
//      仍按参数现算。
import { onRequestPost } from "../functions/save.js";
import { handlePresetGet } from "../functions/_preset.js";

let pass = 0, failN = 0;
const chk = (name, cond, extra = "") => { if (cond) { pass++; console.log("PASS", name); } else { failN++; console.log("FAIL", name, extra); } };

// ── stub KV ────────────────────────────────────────────────────────
class KVStub {
  constructor() { this.m = new Map(); this.puts = []; }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v, opts) { this.puts.push({ k, opts }); this.m.set(k, v); }
}
const kv = new KVStub();

// ── stub 池子（all.txt 一份夹具，所有 GET 共用——_sub_core 取池有
//    120 秒模块级缓存，第一份夹具进缓存后换夹具不生效，故只用一份）
const POOL = [
  "104.16.0.1:443#US12 [官方CF]",
  "104.16.0.2:8443#US34 [官方CF]",
  "8.216.44.94:443#JP56 [第三方]",
  "1.2.3.4:443#HK78 [某源 50ms]",
  "5.6.7.8:443#SG90 [某源]",
].join("\n") + "\n";
const assets = {
  fetch: async (url) => {
    const u = typeof url === "string" ? url : url.href;
    if (u.includes("/data/")) return new Response(POOL, { status: 200 });
    return new Response("", { status: 404 });
  },
};
const env = { SNAP: kv, ASSETS: assets };

const post = async (body) => {
  const req = new Request("https://example.com/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const resp = await onRequestPost({ request: req, env });
  return { status: resp.status, json: await resp.json().catch(() => null) };
};
const get = async (code) => {
  const resp = await handlePresetGet(
    { request: new Request("https://example.com/s/" + code + ".txt"), env }, code);
  return { status: resp.status, text: await resp.text() };
};

// ── ① 合法映射存入 ────────────────────────────────────────────────
const MAP1 = { "104.16.0.1": "HK", "8.216.44.94": "JP", "1.2.3.4": "HK", "9.9.9.9": "US" };
const r1 = await post({ mode: "locmap", map: MAP1 });
chk("① 合法映射 POST 200", r1.status === 200, JSON.stringify(r1));
chk("① 短码形如 m+9hex", !!r1.json && /^m[a-f0-9]{9}$/.test(r1.json.code || ""), r1.json && r1.json.code);
chk("① url 以 /s/<码>.txt 结尾", !!r1.json && r1.json.url === "https://example.com/s/" + r1.json.code + ".txt", r1.json && r1.json.url);
const put1 = kv.puts.find(p => p.k === "locmap:" + (r1.json && r1.json.code));
chk("① KV 写入带 30 天 expirationTtl", !!put1 && put1.opts && put1.opts.expirationTtl === 30 * 24 * 3600,
  put1 ? JSON.stringify(put1.opts) : "no put");
const rec1 = JSON.parse(kv.m.get("locmap:" + r1.json.code));
chk("① 记录含 map/created、fmt 为 null", !!rec1 && rec1.map["104.16.0.1"] === "HK"
  && typeof rec1.created === "number" && rec1.fmt === null);

// ── ② 重复 POST 同码零写入 ────────────────────────────────────────
const putsBefore = kv.puts.filter(p => p.k.startsWith("locmap:")).length;
const r2 = await post({ mode: "locmap", map: { "1.2.3.4": "HK", "9.9.9.9": "US", "8.216.44.94": "JP", "104.16.0.1": "HK" } });
chk("② 键序不同的同一份映射仍同码", r2.status === 200 && r2.json.code === r1.json.code, JSON.stringify(r2.json));
chk("② 新鲜记录不重写 KV", kv.puts.filter(p => p.k.startsWith("locmap:")).length === putsBefore);

// ── ③ 非法 payload 整单 400 ───────────────────────────────────────
const badCases = [
  ["内网 IP", { "10.0.0.1": "HK" }],
  ["环回 IP", { "127.0.0.1": "HK" }],
  ["不存在的地区码", { "1.2.3.4": "XX" }],
  ["小写地区码", { "1.2.3.4": "jp" }],
  ["三字母地区码", { "1.2.3.4": "JPN" }],
  ["值不是字符串", { "1.2.3.4": 12 }],
  ["空映射", {}],
  ["映射是数组", ["1.2.3.4"]],
  ["IP 格式不对", { "999.1.1.1": "HK" }],
];
for (const [name, map] of badCases) {
  const r = await post({ mode: "locmap", map });
  chk("③ 400：" + name, r.status === 400, "got " + r.status);
}
const big = {};
for (let i = 0; i < 2001; i++) big[`1.${(i >> 16) & 127}.${(i >> 8) & 255}.${i & 255}`] = "HK";
const rBig = await post({ mode: "locmap", map: big });
chk("③ 400：2001 条超限", rBig.status === 400, "got " + rBig.status);
const rNoMap = await post({ mode: "locmap" });
chk("③ 400：缺 map 字段", rNoMap.status === 400, "got " + rNoMap.status);

// ── ④ GET 出链逐条核对（fmt 未设 → 默认命名）─────────────────────
const g1 = await get(r1.json.code);
const lines1 = g1.text.split("\n").filter(Boolean);
chk("④ GET 200", g1.status === 200, "got " + g1.status);
chk("④ 只收映射∩池子 3 条（9.9.9.9 不在池、未映射两条不进）", lines1.length === 3, lines1.join(" | "));
chk("④ 按地区分组（HK 在 JP 前）且序号按地区从 1 编",
  lines1[0].startsWith("104.16.0.1:443#香港 HK 1")
  && lines1[1].startsWith("1.2.3.4:443#香港 HK 2")
  && lines1[2].startsWith("8.216.44.94:443#日本 JP 1"), lines1.join(" | "));
chk("④ 名字尾巴保留源标注方括号（默认命名口径）",
  lines1[0].includes("[官方CF]") && lines1[2].includes("[第三方]"), lines1.join(" | "));
chk("④ 地区已按映射改名（104.16.0.1 源标注 US → HK）",
  !lines1.some(l => l.startsWith("104.16.0.1") && l.includes("美国")), lines1.join(" | "));

// ── ⑤ fmt 随记录生效 ──────────────────────────────────────────────
const r3 = await post({ mode: "locmap", map: MAP1, fmt: "{代码} {序号}" });
chk("⑤ 带 fmt 的映射是另一个码", r3.status === 200 && r3.json.code !== r1.json.code, JSON.stringify(r3.json));
const g2 = await get(r3.json.code);
const lines2 = g2.text.split("\n").filter(Boolean);
chk("⑤ fmt 命名生效且无方括号（没选 {来源}/{标签}）",
  lines2.length === 3 && lines2[0] === "104.16.0.1:443#HK 1" && !g2.text.includes("["), lines2.join(" | "));
const r4 = await post({ mode: "locmap", map: MAP1, fmt: "{代码} {序号} [{标签}]" });
const g3 = await get(r4.json.code);
chk("⑤ fmt 含 {标签} 时方括号标注原样带出",
  g3.text.includes("104.16.0.1:443#HK 1 [官方CF]"), g3.text.split("\n")[0]);

// ── ⑥ 不存在的 m 码 404 ───────────────────────────────────────────
const g404 = await get("m000000000");
chk("⑥ 不存在短码 404", g404.status === 404, "got " + g404.status);
chk("⑥ 404 写明已过期、请重新测地区生成",
  g404.text.includes("链接已过期") && g404.text.includes("重新测地区生成"), g404.text.trim());

// ── ⑦ preset 老路回归 ─────────────────────────────────────────────
const rp = await post({ mode: "preset", params: { regions: "JP" } });
chk("⑦ preset 仍回 10 位 hex 码", rp.status === 200 && /^[a-f0-9]{10}$/.test(rp.json.code || ""), JSON.stringify(rp.json));
const gp = await get(rp.json.code);
chk("⑦ preset GET 仍按参数现算（regions=JP 只出 JP 源标注行）",
  gp.status === 200 && gp.text.includes("8.216.44.94") && !gp.text.includes("104.16.0.1"), gp.text.trim());

console.log(`\nlocmap-fn: pass=${pass} fail=${failN}`);
if (failN) process.exit(1);
