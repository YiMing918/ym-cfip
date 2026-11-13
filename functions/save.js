// POST /save {text} → {id, url}：把访客当前清单存为快照订阅（KV: SNAP）
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
  if (!context.env || !context.env.SNAP)
    return new Response(JSON.stringify({ error: "snapshot storage not configured（快照存储未配置：本站未绑定 SNAP KV）" }), { status: 501, headers });
  const body = await context.request.json().catch(() => null);
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
  const ip = context.request.headers.get("cf-connecting-ip") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const rlKey = "rl:save:" + day;
  let doc = { total: 0, ips: {} };
  try { doc = JSON.parse((await context.env.SNAP.get(rlKey)) || "null") || doc; } catch (e) { /* 计数文档损坏按零起算 */ }
  if ((doc.ips[ip] || 0) >= 100 || doc.total >= 200)
    return new Response(JSON.stringify({ error: "daily save limit reached（今日保存次数已达上限，明天再来）" }), { status: 429, headers });
  await context.env.SNAP.put("snap:" + id, stored, { expirationTtl: 180 * 24 * 3600 });
  doc.total += 1;
  doc.ips[ip] = (doc.ips[ip] || 0) + 1;
  await context.env.SNAP.put(rlKey, JSON.stringify(doc), { expirationTtl: 2 * 24 * 3600 });
  return new Response(JSON.stringify({ id, url: new URL("/s/" + id, context.request.url).href }), { headers });
}
