// POST /save {text} → {id, url}：把访客当前清单存为快照订阅（KV: SNAP）
// POST /save {mode:"preset", params} → {code, url}：把一组订阅参数存为
// 预设（v1.24），页面据此展示短链 /s/<短码>.txt，见文件后半 handlePreset。
import { handleSub } from "./_sub_core.js";
// 快照是定格版（可含本地测通筛选），不随聚合变化；保留 180 天；链接即凭证（内容本就是公开 IP 清单）。
// id 由内容 SHA-256 派生（同内容同 id）：重复保存直接返回已有链接、零写入，
// 既省 KV 写额度，也让「同一份清单永远同一个链接」。
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
async function contentId(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf).slice(0, 10)].map(x => ALPHABET[x % ALPHABET.length]).join("");
}
// 与聚合脚本 aggregate.py 同口径校验：只收全球单播地址。
// v4：逐段判范围之外，再拦环回/内网/链路本地/运营商级 NAT/组播/保留/
// 文档示例等特殊段（与 aggregate.py 的 is_global 判定一致）。
// v6：此前只查十六进制字符集，[::1]、[fe80::1]、[fd00::1] 乃至 [:::]
// 这类非法/非全球地址都能存入快照，与 aggregate.py 的 _v6_ok
// （IPv6Address.is_global）口径不符，现做完整的展开与段判定。
function ipv4Nums(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  if (!parts.every(p => /^[0-9]+$/.test(p) && p.length <= 3 && Number(p) <= 255))
    return null;
  return parts.map(Number);
}
function ipv4GlobalNums(n) {
  const [a, b] = n;
  if (a === 0 || a === 10 || a === 127) return false;          // 本网络 / 私有 / 环回
  if (a === 100 && b >= 64 && b <= 127) return false;          // 100.64/10 CGNAT
  if (a === 169 && b === 254) return false;                    // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return false;           // 172.16/12 私有
  if (a === 192 && b === 0 && n[2] === 0) return false;        // 192.0.0/24
  if (a === 192 && b === 0 && n[2] === 2) return false;        // 192.0.2/24 文档示例
  if (a === 192 && b === 168) return false;                    // 私有
  if (a === 198 && (b === 18 || b === 19)) return false;       // 198.18/15 基准测试
  if (a === 198 && b === 51 && n[2] === 100) return false;     // 文档示例
  if (a === 203 && b === 0 && n[2] === 113) return false;      // 文档示例
  if (a >= 224) return false;                                  // 组播 224/4 + 保留 240/4
  return true;
}
function validIPv4(ip) {
  const n = ipv4Nums(ip);
  return n !== null && ipv4GlobalNums(n);
}
function expandIPv6(s) {
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  let groups;
  if (tail === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map(g => parseInt(g, 16));
}
function validIPv6Global(ip) {
  let s = String(ip).toLowerCase();
  let mapped = null;
  if (s.includes(".")) {
    // 内嵌 IPv4 尾段（如 ::ffff:1.2.3.4）：先验点分格式，再换算成两组十六进制
    const i = s.lastIndexOf(":");
    if (i < 0) return false;
    mapped = ipv4Nums(s.slice(i + 1));
    if (!mapped) return false;
    const hi = ((mapped[0] << 8) | mapped[1]).toString(16);
    const lo = ((mapped[2] << 8) | mapped[3]).toString(16);
    s = s.slice(0, i + 1) + hi + ":" + lo;
  }
  const g = expandIPv6(s);
  if (!g) return false;
  const g0 = g[0];
  if (g.every(x => x === 0)) return false;                            // :: 未指定
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return false;  // ::1 环回
  if ((g0 & 0xffc0) === 0xfe80) return false;                         // fe80::/10 链路本地
  if ((g0 & 0xfe00) === 0xfc00) return false;                         // fc00::/7 ULA
  if ((g0 & 0xff00) === 0xff00) return false;                         // ff00::/8 组播
  if (g0 === 0x2001 && g[1] === 0x0db8) return false;                 // 2001:db8::/32 文档示例
  if (g0 === 0x2001 && g[1] === 0x0000) return false;                 // 2001::/32 Teredo（与聚合端 is_global 口径一致）
  if (g0 === 0x2001 && g[1] === 0x0002) return false;                 // 2001:2::/48 基准测试
  if (g0 === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // 100::/64 丢弃段
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff)           // v4 映射地址看内嵌 v4
    return mapped !== null && ipv4GlobalNums(mapped);
  if (g.slice(0, 6).every(x => x === 0)) return false;                // 其余 0 段前缀形式
  return true;
}
function validPort(port) {
  return /^[0-9]+$/.test(port) && port.length <= 5
    && Number(port) > 0 && Number(port) <= 65535;
}
const LINE_RE = /^(\[([0-9a-fA-F:.]+)\]|(\d{1,3}(?:\.\d{1,3}){3})):(\d+)(#(.*))?$/;
// # 后缀必须是本站自己的标注语法（#地区序号 + 可选 [来源标签]）：此前 #.*
// 不限内容，等于允许在本域名下托管任意文本（/s/<id> 以 text/plain 公开
// 读出）。标签内只许文字/数字/常见标点并限长，尖括号与控制字符一律拒绝。
const LABEL_RE = /^([A-Z]{2}\d*|IPv6\d*|SW\d*)( \[[^\[\]<>]{0,60}\])?$/;
function lineOk(l) {
  const m = l.match(LINE_RE);
  if (!m) return false;
  if (m[3] !== undefined && !validIPv4(m[3])) return false;
  if (m[2] !== undefined && !validIPv6Global(m[2])) return false;
  if (m[6] !== undefined && !LABEL_RE.test(m[6])) return false;
  return validPort(m[4]);
}

export async function onRequestPost(context) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" };
  // 来源校验（C-25，与 ym-cf-panel _auth.js 同款）：带 Origin 时其 host 必须
  // 与请求 URL 的 host 一致，不一致直接 403；不带 Origin 的维持现状（脚本
  // 直调等无 Origin 客户端不受影响）。/save 是匿名写 KV 的入口，跨站页面
  // 借访客浏览器发 POST 刷保存额度/塞快照这条路要先堵上。
  const origin = context.request.headers.get("Origin");
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === new URL(context.request.url).host; } catch { ok = false; }
    if (!ok)
      return new Response(JSON.stringify({ error: "bad origin（请求来源不对）" }), { status: 403, headers });
  }
  if (!context.env || !context.env.SNAP)
    return new Response(JSON.stringify({ error: "snapshot storage not configured（快照存储未配置：本站未绑定 SNAP KV）" }), { status: 501, headers });
  const body = await context.request.json().catch(() => null);
  if (body && body.mode === "preset") return handlePreset(context, body, headers);
  const text = body && typeof body.text === "string" ? body.text : "";
  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
  if (!lines.length || lines.length > 5000 || text.length > 300000)
    return new Response(JSON.stringify({ error: "invalid list（清单无效：为空或条数/长度超限）" }), { status: 400, headers });
  if (!lines.every(l => lineOk(l)))
    return new Response(JSON.stringify({ error: "invalid line format（清单里有行格式不对）" }), { status: 400, headers });
  const stored = lines.join("\n") + "\n";
  const id = await contentId(stored);
  // 同内容已存过：直接返回已有链接，不写 KV、不计限额（重复点保存零成本）
  if (await context.env.SNAP.get("snap:" + id))
    return new Response(JSON.stringify({ id, url: new URL("/s/" + id, context.request.url).href }), { headers });
  // 保存限额（防刷爆 KV 写额度）：单文档计数 rl:save:<yyyy-mm-dd> 同时记
  // 全站总量与各来源 IP——此前只有每 IP 上限，换几个 IP 就能把全站每日
  // 1000 次写额度打满；现加全站每日上限 200 次新快照（每次 2 写、全天
  // 最多 400 写封顶）。KV 无原子计数，并发下计数是尽力而为，总量级受控。
  //
  // 占额顺序（2026-11-17 审计核验 #4）：旧顺序是「先写快照、后加计数」，
  // 写完快照后计数没落库（崩溃/并发覆盖）就留下一个永不计数的快照，限额
  // 被绕过且无账可查。现改为先占额再写对象：
  //   1) 先把计数 +1 落库（占额）；
  //   2) 占额后复核：重新读计数，若全站总量已超上限（并发把额度抢超了），
  //      退还本次占额并拒绝——超限快照根本不写出；
  //   3) 写快照失败同样退还占额。
  // KV 没有 CAS，这仍是尽力而为，但保证了「计数先于对象」：新路径不再产生
  // 未计数的快照；计数只可能多计（占额后异常未退还），方向是保守的。
  const ip = context.request.headers.get("cf-connecting-ip") || "unknown";
  // 日界按北京时间（与 sub.js 的 {日期} 同口径）：用 UTC 日期会在北京
  // 时间 08:00 才换日，「今日上限」对国内用户错位 8 小时
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const rlKey = "rl:save:" + day;
  const readDoc = async () => {
    try { return JSON.parse((await context.env.SNAP.get(rlKey)) || "null") || { total: 0, ips: {} }; }
    catch (e) { return { total: 0, ips: {} }; /* 计数文档损坏按零起算 */ }
  };
  const writeDoc = d => context.env.SNAP.put(rlKey, JSON.stringify(d), { expirationTtl: 2 * 24 * 3600 });
  const release = async () => {
    const d = await readDoc();
    d.total = Math.max(0, d.total - 1);
    d.ips[ip] = Math.max(0, (d.ips[ip] || 0) - 1);
    await writeDoc(d).catch(() => {});
  };
  let doc = await readDoc();
  if ((doc.ips[ip] || 0) >= 100 || doc.total >= 200)
    return new Response(JSON.stringify({ error: "daily save limit reached（今日保存次数已达上限，明天再来）" }), { status: 429, headers });
  doc.total += 1;
  doc.ips[ip] = (doc.ips[ip] || 0) + 1;
  try {
    await writeDoc(doc); // 先占额
  } catch (e) {
    // 占额写失败与 release() 内的 writeDoc 同口径处理（2026-11-19 审计
    // M10）：此前这里裸 await，KV 写失败直接抛到 Functions 层变 500；
    // 占额没落库就等于没占，直接回 502 让访客重试即可，不留半截状态
    return new Response(JSON.stringify({ error: "save failed, please retry（保存失败，请重试）" }), { status: 502, headers });
  }
  const after = await readDoc(); // 占额后全站复核
  if (after.total > 200) {
    await release();
    return new Response(JSON.stringify({ error: "daily save limit reached（今日保存次数已达上限，明天再来）" }), { status: 429, headers });
  }
  try {
    await context.env.SNAP.put("snap:" + id, stored, { expirationTtl: 180 * 24 * 3600 });
  } catch (e) {
    await release();
    return new Response(JSON.stringify({ error: "save failed, please retry（保存失败，请重试）" }), { status: 502, headers });
  }
  return new Response(JSON.stringify({ id, url: new URL("/s/" + id, context.request.url).href }), { headers });
}

// ── 参数预设（v1.24）：{mode:"preset", params:{...}} → {code, url} ──
// 页面把当前订阅选项（regions/fmt/ui 等）存成预设，展示的订阅链接就变成
// /s/<短码>.txt：.txt 结尾、无问号参数尾巴，和别家优选源的 TXT 直链同形，
// 填进哪个订阅后台都一样。短码 = 参数集规范化 JSON 的 SHA-256 前 10 位
// （十六进制）：同一套选择永远同一个码，重复生成直接返回已有短码、零写入、
// 不计限额（与快照的 contentId 同思路）。预设只存参数不存数据，永不过期：
// 内容由 /s/[id].txt.js 在拉取时按最新聚合数据现算，池子更新自动跟上。
// 参数校验不另写一份：拿参数真跑一遍 handleSub，但喂一个必然 404 的取池
// 桩——参数不合法时 handleSub 在取池之前就回 400（校验全在取池前完成），
// 所以探针只认 400 为非法；合法参数走到取池这步：冷缓存时桩回 404 使它
// 回 502，热缓存时直接命中缓存回 200，两种都算合法。取池对失败结果不
// 写缓存，这个探针不会污染真实取池。两边口径永远一致，不会漂移。
const PRESET_KEYS = new Set(["regions", "rn", "n", "ms", "mbps", "carrier", "ports", "mode", "stack", "group", "fmt", "ui"]);
function presetCanon(params) {
  return JSON.stringify(Object.fromEntries(
    Object.keys(params).sort().map(k => [k, params[k]])));
}
async function presetCode(params) {
  const buf = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(presetCanon(params)));
  return [...new Uint8Array(buf)]
    .map(x => x.toString(16).padStart(2, "0")).join("").slice(0, 10);
}
async function handlePreset(context, body, headers) {
  const raw = body.params;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return new Response(JSON.stringify({ error: "invalid params（参数缺失或格式不对）" }), { status: 400, headers });
  const params = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!PRESET_KEYS.has(k) || typeof v !== "string" || v.length > 300)
      return new Response(JSON.stringify({ error: "invalid params（参数名或参数值不合法）" }), { status: 400, headers });
    const val = v.trim();
    if (val) params[k] = val; // 空串等同未传，与订阅端点同口径
  }
  // fmt 与订阅端点同口径：截断 300、去换行，纯空白等同未设
  if (params.fmt !== undefined) {
    const f = params.fmt.slice(0, 300).replace(/[\r\n]/g, "");
    if (f.trim() === "") delete params.fmt; else params.fmt = f;
  }
  const qs = new URLSearchParams(params).toString();
  const probe = await handleSub({
    request: new Request("http://local/sub.txt" + (qs ? "?" + qs : "")),
    env: { ASSETS: { fetch: async () => new Response("", { status: 404 }) } },
  });
  if (probe.status === 400) {
    const msg = (await probe.text()).trim().replace(/^#\s*/, "");
    return new Response(JSON.stringify({ error: msg + "（预设参数不合法）" }), { status: 400, headers });
  }
  const code = await presetCode(params);
  const url = new URL("/s/" + code + ".txt", context.request.url).href;
  // 同一套参数已存过：直接返回已有短码，不写 KV、不计限额
  if (await context.env.SNAP.get("preset:" + code))
    return new Response(JSON.stringify({ code, url }), { headers });
  // 新预设才写 KV：限额口径与快照一致（防匿名刷爆每日写额度），独立计数
  // 文档 rl:preset:<北京时间日期>，全站每日最多 200 个新预设、单 IP 100 个；
  // 同样先占额再写对象、失败退还（理由见上方快照段注释）。
  const ip = context.request.headers.get("cf-connecting-ip") || "unknown";
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const rlKey = "rl:preset:" + day;
  const readDoc = async () => {
    try { return JSON.parse((await context.env.SNAP.get(rlKey)) || "null") || { total: 0, ips: {} }; }
    catch (e) { return { total: 0, ips: {} }; }
  };
  const writeDoc = d => context.env.SNAP.put(rlKey, JSON.stringify(d), { expirationTtl: 2 * 24 * 3600 });
  const release = async () => {
    const d = await readDoc();
    d.total = Math.max(0, d.total - 1);
    d.ips[ip] = Math.max(0, (d.ips[ip] || 0) - 1);
    await writeDoc(d).catch(() => {});
  };
  let doc = await readDoc();
  if ((doc.ips[ip] || 0) >= 100 || doc.total >= 200)
    return new Response(JSON.stringify({ error: "daily save limit reached（今日保存次数已达上限，明天再来）" }), { status: 429, headers });
  doc.total += 1;
  doc.ips[ip] = (doc.ips[ip] || 0) + 1;
  try {
    await writeDoc(doc); // 先占额
  } catch (e) {
    return new Response(JSON.stringify({ error: "save failed, please retry（保存失败，请重试）" }), { status: 502, headers });
  }
  const after = await readDoc(); // 占额后全站复核
  if (after.total > 200) {
    await release();
    return new Response(JSON.stringify({ error: "daily save limit reached（今日保存次数已达上限，明天再来）" }), { status: 429, headers });
  }
  try {
    await context.env.SNAP.put("preset:" + code, presetCanon(params)); // 永不过期
  } catch (e) {
    await release();
    return new Response(JSON.stringify({ error: "save failed, please retry（保存失败，请重试）" }), { status: 502, headers });
  }
  return new Response(JSON.stringify({ code, url }), { headers });
}
