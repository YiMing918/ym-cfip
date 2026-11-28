// 测地区结果订阅（v1.33）：把访客在浏览器里测出的「IP → 真实地区」
// 映射存进 KV（SNAP，键 locmap:<短码>，30 天自动过期），订阅链接仍走
// /s/<短码>.txt——短码是 'm' + 9 位十六进制：'m' 不是十六进制字符，
// preset 的 10 位纯十六进制短码永不以 m 开头，两个命名空间零碰撞，
// _preset.js 按码形分流。写入口在 save.js（mode:"locmap"，与 preset
// 并列，同一套 Origin 校验与限额口径）。
// 拉取时现算（本文件 handleLocmapGet）：拿当前总池 ∩ 映射——只收
// 映射里有的 IP，地区代码改成映射的，再按地区分组、套用生成时存下
// 的导出格式（fmt）出名单，与页面「按实测/注册地导出」同口径：序号
// 按地区从 1 编；名字带不带源标注方括号由 fmt 里有没有 {来源}/{标签}
// 决定。映射里的 IP 若已被聚合轮换出池子，自然不在名单里；没测过
// 的新 IP 没有映射、也不会进。映射只存「IP → 地区」这一件测得的
// 事实，不存访客的任何其他东西。
import { loadPool, parseLine, applyFmt, NAMES } from "./_sub_core.js";

export const LOCMAP_CODE_RE = /^m[a-f0-9]{9}$/;
export const LOCMAP_TTL = 30 * 24 * 3600; // 30 天（秒，KV expirationTtl 口径）
export const LOCMAP_MAX = 2000;
// 合法地区集合：订阅端点国家名表（页面 COLO_CC 的取值全在里面）+
// 注册地数据（data/geo.json）里出现过、名表里没有的 SC（塞舌尔）。
// 校验从严：不认识的国家码不收，免得拼错的码把名单改名到不存在的
// 地区；geo 数据以后出现新国家时，先往这里补再放行。
export const LOCMAP_CCS = new Set([...Object.keys(NAMES), "SC"]);

// 与 aggregate.py / save.js 同口径的全球单播 IPv4 判定（本站第三份
// 同口径实现：save.js 的快照校验、probe.js 的建记录校验各一份——
// 模块间不互相 import 校验函数，是本站既有格局，避免循环依赖）。
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
export function validGlobalIPv4(ip) {
  const n = ipv4Nums(ip);
  return n !== null && ipv4GlobalNums(n);
}

// 映射整单校验：普通对象、1..2000 条、键全是合法公网 IPv4、值全是
// 合法地区集合内的两位代码。任何一条不合格整单拒（与 /save 快照的
// 「有行不对整单 400」同口径），不静默丢条目——丢了访客不会知道，
// 名单会悄悄缺节点。
export function validLocmap(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return false;
  const keys = Object.keys(map);
  if (!keys.length || keys.length > LOCMAP_MAX) return false;
  return keys.every(ip => validGlobalIPv4(ip)
    && typeof map[ip] === "string" && LOCMAP_CCS.has(map[ip]));
}

// fmt 与订阅端点同口径清洗：截断 300、去换行，纯空白等同未设（null）。
export function cleanLocmapFmt(raw) {
  if (typeof raw !== "string") return null;
  const f = raw.slice(0, 300).replace(/[\r\n]/g, "");
  return f.trim() === "" ? null : f;
}

// 短码由内容派生（与快照 contentId / preset presetCode 同思路）：
// 规范化 JSON（条目按 IP 排序、fmt 在内）的 SHA-256 取前 9 位十六
// 进制、加 'm' 前缀。同一份映射永远同一个码——重复生成直接命中
// 已存记录、零写入、不计限额。
export async function locmapCode(map, fmt) {
  const canon = JSON.stringify({
    f: fmt || "",
    m: Object.keys(map).sort().map(ip => [ip, map[ip]]),
  });
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  return "m" + [...new Uint8Array(buf)]
    .map(x => x.toString(16).padStart(2, "0")).join("").slice(0, 9);
}

// GET /s/<m 短码>.txt 的生成逻辑（由 _preset.js 按码形转交）。
export async function handleLocmapGet(context, code) {
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "profile-update-interval": "24" };
  if (!context.env || !context.env.SNAP)
    return new Response("# locmap storage not configured\n", { status: 501, headers });
  const raw = await context.env.SNAP.get("locmap:" + code);
  if (!raw)
    return new Response("# 链接已过期，请重新测地区生成（测地区结果只保存 30 天）\n", { status: 404, headers });
  let rec = null;
  try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)
      || !rec.map || typeof rec.map !== "object" || Array.isArray(rec.map))
    return new Response("# locmap corrupted\n", { status: 500, headers });
  const url = new URL(context.request.url);
  let pool = null;
  try { pool = await loadPool(context, url.origin, "/data/all.txt"); } catch (e) { pool = null; }
  if (pool === null)
    return new Response("# data unavailable\n", { status: 502, headers });
  // 当前池 ∩ 映射：逐行取 IP（去端口）查映射，命中才收、地区改成
  // 映射的；同行去重与页面导出一致（改名后完全相同的行只留一条）。
  const byRegion = {};
  const seen = new Set();
  for (const rawLine of pool) {
    const p = parseLine(rawLine);
    if (!p) continue;
    const ip = p.addr.replace(/:\d+$/, "");
    const cc = rec.map[ip];
    if (!cc) continue;
    const nl = rawLine.replace(/#[A-Z]{2}\d*/, "#" + cc + "1");
    if (seen.has(nl)) continue;
    seen.add(nl);
    (byRegion[cc] = byRegion[cc] || []).push(nl);
  }
  const out = [];
  for (const cc of Object.keys(byRegion).sort()) out.push(...byRegion[cc]);
  const fmt = cleanLocmapFmt(rec.fmt);
  return new Response(applyFmt(out, fmt).join("\n") + "\n", { headers });
}
