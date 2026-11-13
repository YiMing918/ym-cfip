// YM 优选 IP · 订阅端点（Cloudflare Pages Functions）
// 参数：
//   regions=JP,US      地区（缺省 JP,US）
//   n=20               每地区最多 N 个
//   rn=JP.10,US.5      单独定每地区个数（覆盖 n）
//   ms=200             最大延迟（源标注）  mbps=10  最低速度（源标注）
//   carrier=移动,电信  运营商可多选逗号分隔（带标注的只留所选；无标注源保留）
//   ports=tls          端口：all（缺省）| 443 | tls(443/8443/2053/2083/2087/2096)
//   mode=random        随机抽取（缺省质量优先源序）
//   stack=6            IPv6 池（此时 regions/ms/mbps 不适用，可用 n/carrier）
//   group=best|full|extra|sw|all  数据分组（缺省 all 合并总表；与页面分组对应）
//   ui=12              建议客户端更新间隔（小时，写响应头）
// 参数非法（ms/mbps 非数字、ports/mode/group/stack 取值不在枚举内、n/rn
// 为负）时返回 400 并注明哪个参数错了，不再静默忽略或悄悄给空结果。
// 每次请求基于最新聚合数据现算，链接内容实时更新。
const LINE_RE = /^(\S+?)#([A-Z]{2})\d*\s*(?:\[(.*)\])?$/;

// 导出时重编序号：#JP 后、方括号前加同地区序号（子集筛选后从 1 连续编）
function renumber(lines) {
  const cnt = {};
  return lines.map(l => l.replace(/^(\S+?)#(IPv6|[A-Z]{2})\d*/, (m, a, cc) => {
    cnt[cc] = (cnt[cc] || 0) + 1;
    return `${a}#${cc}${cnt[cc]}`;
  }));
}

const NAMES = {CN:'中国',SW:'三网专区',HK:'香港',TW:'台湾',JP:'日本',KR:'韩国',SG:'新加坡',US:'美国',GB:'英国',DE:'德国',FR:'法国',NL:'荷兰',CA:'加拿大',AU:'澳大利亚',IN:'印度',ID:'印尼',TH:'泰国',VN:'越南',PH:'菲律宾',MY:'马来西亚',AE:'阿联酋',AR:'阿根廷',OM:'阿曼',SA:'沙特',EG:'埃及',BR:'巴西',MX:'墨西哥',CL:'智利',NZ:'新西兰',CH:'瑞士',SE:'瑞典',NO:'挪威',DK:'丹麦',FI:'芬兰',PL:'波兰',ES:'西班牙',IT:'意大利',PT:'葡萄牙',IE:'爱尔兰',BE:'比利时',AT:'奥地利',CZ:'捷克',GR:'希腊',TR:'土耳其',IL:'以色列',RU:'俄罗斯',UA:'乌克兰',KZ:'哈萨克斯坦',TM:'土库曼斯坦',KH:'柬埔寨',PK:'巴基斯坦',LV:'拉脱维亚',EE:'爱沙尼亚',LT:'立陶宛',BG:'保加利亚',RO:'罗马尼亚',MD:'摩尔多瓦',RS:'塞尔维亚',IS:'冰岛',AM:'亚美尼亚',CY:'塞浦路斯',AL:'阿尔巴尼亚',DO:'多米尼加',HU:'匈牙利',GE:'格鲁吉亚',BY:'白俄罗斯',AZ:'阿塞拜疆',KG:'吉尔吉斯斯坦',LA:'老挝',ZA:'南非',MM:'缅甸',BD:'孟加拉',NP:'尼泊尔',LK:'斯里兰卡'};
function flagEmoji(cc) {
  if (!cc || !/^[A-Z]{2}$/.test(cc) || cc === "SW") return "";
  return String.fromCodePoint(...[...cc].map(c => 127397 + c.charCodeAt(0)));
}
function parseAnySub(line) {
  const p = parseLine(line);
  if (p) return p;
  const m = line.match(/^(\[[^\]]+\]:\d+)#IPv6\d*\s*(?:\[(.*)\])?$/);
  if (m) return { line, addr: m[1], region: "IPv6", tag: m[2] || "",
                  port: (m[1].match(/:(\d+)$/) || [])[1] || "",
                  carrier: ((m[2] || "").match(/·(移动|电信|联通|广电)/) || [])[1] || "",
                  srcMs: null, srcMbps: null };
  return null;
}
function srcName(tag) {
  return (tag || "").replace(/[\d.]+\s*ms/i, "").replace(/[\d.]+\s*Mbps/i, "")
    .replace(/·(移动|电信|联通|广电)/, "").replace(/\s+/g, " ").trim();
}
// fmt 模板（页面「导出格式」经订阅参数传入）：变量 {地区}{代码}{序号}{延迟}{网速}{运营商}{来源}{端口}{日期}{标签}{旗帜}
function applyFmt(lines, fmt) {
  if (fmt === null) return renumber(lines);
  const cnt = {};
  return lines.map(l => {
    const p = parseAnySub(l);
    if (!p) return l;
    cnt[p.region] = (cnt[p.region] || 0) + 1;
    let r = fmt
      .replaceAll("{地区}", p.region === "IPv6" ? "IPv6" : (NAMES[p.region] || p.region))
      .replaceAll("{代码}", p.region)
      .replaceAll("{序号}", String(cnt[p.region]))
      .replaceAll("{延迟}", p.srcMs !== null ? `${p.srcMs}ms` : "")
      .replaceAll("{网速}", p.srcMbps ? `${p.srcMbps}Mbps` : "")
      .replaceAll("{运营商}", p.carrier || "")
      .replaceAll("{来源}", srcName(p.tag))
      .replaceAll("{端口}", p.port || "")
      .replaceAll("{日期}", new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10))
      .replaceAll("{标签}", p.tag || "")
      .replaceAll("{旗帜}", flagEmoji(p.region));
    r = r.replace(/\[\s*\]/g, "").replace(/\s+/g, " ").trim();
    return r ? `${p.addr}#${r}` : p.addr;
  });
}
const TLS_PORTS = new Set(["443", "8443", "2053", "2083", "2087", "2096"]);

function parseLine(line) {
  const m = line.match(LINE_RE);
  if (!m) return null;
  const tag = m[3] || "";
  const ms = tag.match(/([\d.]+)\s*ms/i);
  const mbps = tag.match(/([\d.]+)\s*Mbps/i);
  const port = (m[1].match(/:(\d+)$/) || [])[1] || "";
  const carrier = (tag.match(/·(移动|电信|联通|广电)/) || [])[1] || "";
  return {
    line, addr: m[1], region: m[2], tag, port, carrier,
    srcMs: ms ? parseFloat(ms[1]) : null,
    srcMbps: mbps ? parseFloat(mbps[1]) : null,
  };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function loadPool(context, origin, file) {
  const dataUrl = new URL(file, origin);
  const resp = context.env && context.env.ASSETS
    ? await context.env.ASSETS.fetch(dataUrl)
    : await fetch(dataUrl);
  if (!resp.ok) return [];
  const txt = await resp.text();
  return txt.split("\n").map(s => s.trim()).filter(Boolean);
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const q = url.searchParams;
  const ui = parseInt(q.get("ui") || "", 10);
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" };
  if (!isNaN(ui) && ui > 0) headers["profile-update-interval"] = String(ui);

  const badParam = name => new Response(
    `# 参数错误：${name} 的取值不合法，请检查订阅链接\n`,
    { status: 400, headers });
  const nAll = parseInt(q.get("n") || "", 10);
  if (q.get("n") !== null && (isNaN(nAll) || nAll < 1)) return badParam("n");
  const carrier = q.get("carrier") || "";
  const carrierSet = new Set(carrier.split(",").map(x => x.trim()).filter(Boolean));
  const mode = q.get("mode") || "";
  if (mode && mode !== "random") return badParam("mode");
  if (q.get("stack") !== null && q.get("stack") !== "6") return badParam("stack");
  const group = q.get("group") || "all";
  if (!["best", "full", "extra", "sw", "all"].includes(group)) return badParam("group");
  const fmtRaw = q.get("fmt");
  const fmt = fmtRaw === null ? null : fmtRaw.slice(0, 300).replace(/[\r\n]/g, "");

  try {
    if (q.get("stack") === "6") {
      let pool = await loadPool(context, url.origin, "/data/all6.txt");
      if (carrierSet.size) pool = pool.filter(l => { const m = l.match(/·(移动|电信|联通|广电)/); return !m || carrierSet.has(m[1]); });
      if (mode === "random") pool = shuffle(pool);
      const out = isNaN(nAll) ? pool : pool.slice(0, Math.max(0, nAll));
      return new Response(applyFmt(out, fmt).join("\n") + "\n", { headers });
    }

    const regions = new Set(
      (q.get("regions") || (group === "sw" ? "SW" : "JP,US"))
        .split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
    );
    const rn = {};
    let rnBad = false;
    (q.get("rn") || "").split(",").forEach(part => {
      if (!part.trim()) return;
      const [cc, v] = part.split(".");
      const num = v ? parseInt(v, 10) : NaN;
      // rn 值非法/为负：整单 400，不再静默吞掉（原实现把 NaN 存进 rn 时
      // slice(0, NaN) 会把该地区悄悄清空，负数则悄悄给空，都难以排查）
      if (!cc || Number.isNaN(num) || num < 0) { rnBad = true; return; }
      rn[cc.trim().toUpperCase()] = num;
    });
    if (rnBad) return badParam("rn");
    const maxMs = parseFloat(q.get("ms") || "");
    if (q.get("ms") !== null && isNaN(maxMs)) return badParam("ms");
    const minMbps = parseFloat(q.get("mbps") || "");
    if (q.get("mbps") !== null && isNaN(minMbps)) return badParam("mbps");
    const ports = q.get("ports") || "all";
    if (!["all", "443", "tls"].includes(ports)) return badParam("ports");

    const pool = await loadPool(context, url.origin, `/data/${group}.txt`);
    const byRegion = {};
    for (const raw of pool) {
      const p = parseLine(raw);
      if (!p || !regions.has(p.region)) continue;
      if (!isNaN(maxMs) && (p.srcMs === null || p.srcMs > maxMs)) continue;
      if (!isNaN(minMbps) && (p.srcMbps === null || p.srcMbps < minMbps)) continue;
      if (carrierSet.size && p.carrier && !carrierSet.has(p.carrier)) continue;
      if (ports === "443" && p.port !== "443") continue;
      if (ports === "tls" && !TLS_PORTS.has(p.port)) continue;
      (byRegion[p.region] = byRegion[p.region] || []).push(p.line);
    }
    const out = [];
    for (const cc of Object.keys(byRegion).sort()) {
      let lines = byRegion[cc];
      if (mode === "random") lines = shuffle(lines);
      const limit = rn[cc] !== undefined ? rn[cc] : (isNaN(nAll) ? Infinity : nAll);
      out.push(...lines.slice(0, Math.max(0, limit)));
    }
    return new Response(applyFmt(out, fmt).join("\n") + "\n", { headers });
  } catch (e) {
    return new Response("# data unavailable\n", { status: 502, headers });
  }
}
