// YM 优选 IP · 订阅端点公共逻辑（Cloudflare Pages Functions）
// /sub 与 /sub.txt 两个入口共用本文件：参数、输出完全一致，
// /sub.txt 是带问号参数的直算形式，/sub 保留兼容旧链接；
// v1.24 起页面生成的正式形式是预设短链 /s/<短码>.txt（参数存 KV、
// 由 functions/_preset.js 读出后转调本文件的 handleSub 现算），
// 三个入口同一套参数、同一份输出。
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

// 导出时重编序号（子集筛选后从 1 连续编），并把名字换成
// 「地区中文名 代码 序号」打头（v1.25）：名字这样排，CFNext 这类
// 后台能把地区提炼成「地区-序号」，与天诚等源在它里面的样子一致
// （提炼规则见下方 {来源} 处的说明）；别的后台原样显示也一眼能
// 分清地区。方括号里的源标注原样保留在名字尾巴上。
function renumber(lines) {
  const cnt = {};
  return lines.map(l => l.replace(/^(\S+?)#(IPv6|[A-Z]{2})\d*/, (m, a, cc) => {
    cnt[cc] = (cnt[cc] || 0) + 1;
    if (cc === "IPv6") return `${a}#IPv6 ${cnt[cc]}`;
    return `${a}#${NAMES[cc] || cc} ${cc} ${cnt[cc]}`;
  }));
}

const NAMES = {CN:'中国',SW:'三网专区',HK:'香港',TW:'台湾',JP:'日本',KR:'韩国',SG:'新加坡',US:'美国',GB:'英国',DE:'德国',FR:'法国',NL:'荷兰',CA:'加拿大',AU:'澳大利亚',IN:'印度',ID:'印尼',TH:'泰国',VN:'越南',PH:'菲律宾',MY:'马来西亚',AE:'阿联酋',AR:'阿根廷',OM:'阿曼',SA:'沙特',EG:'埃及',BR:'巴西',MX:'墨西哥',CL:'智利',NZ:'新西兰',CH:'瑞士',SE:'瑞典',NO:'挪威',DK:'丹麦',FI:'芬兰',PL:'波兰',ES:'西班牙',IT:'意大利',PT:'葡萄牙',IE:'爱尔兰',BE:'比利时',AT:'奥地利',CZ:'捷克',GR:'希腊',TR:'土耳其',IL:'以色列',IR:'伊朗',RU:'俄罗斯',UA:'乌克兰',KZ:'哈萨克斯坦',TM:'土库曼斯坦',KH:'柬埔寨',PK:'巴基斯坦',LV:'拉脱维亚',EE:'爱沙尼亚',LT:'立陶宛',BG:'保加利亚',RO:'罗马尼亚',MD:'摩尔多瓦',RS:'塞尔维亚',IS:'冰岛',AM:'亚美尼亚',CY:'塞浦路斯',AL:'阿尔巴尼亚',DO:'多米尼加',HU:'匈牙利',GE:'格鲁吉亚',BY:'白俄罗斯',AZ:'阿塞拜疆',KG:'吉尔吉斯斯坦',LA:'老挝',ZA:'南非',MM:'缅甸',BD:'孟加拉',NP:'尼泊尔',LK:'斯里兰卡'};
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
// 来源名用中文原名（v1.25 改回）：v1.24 曾把 {来源} 换成英文标签，
// 起因是 CFNext 解析名单时，名字含中文就走「提炼地区」分支、提炼
// 不出就整名清空、下发回退「优选IP-编号」。后来逐行读了它的解析
// 代码并实测确认：它提炼的只是名字开头——开头排成「地区中文名
// 空格 两位代码」时必定提炼成功、下发成「地区-序号」，和天诚优选
// 等源在它里面的名字完全同形；名字后半段是什么语言它不管。所以
// 正解是把名字开头排成那个形状（无 fmt 时 renumber 这么排、页面
// 默认命名格式也这么排），{来源} 用回中文原名，哪个后台都分得清。
// 未知来源、ASCII 来源都原样；无来源标注就空着（多余空格会被
// applyFmt 压掉）。
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

// 取池缓存（v1.23）：聚合数据约每 2 小时才更新一轮，此前每次请求都回源
// 拉整池再现算，单次响应要数秒，慢到只等 6 秒的订阅后台（如 CFNext 拉源）
// 经常超时整源作废。模块级缓存 120 秒，重复拉取直接命中，响应回到毫秒级；
// 新一轮聚合发布会换新部署进程，缓存不会跨版本读到旧数据。
const poolCache = new Map();
const POOL_TTL_MS = 120 * 1000;
async function loadPool(context, origin, file) {
  const hit = poolCache.get(file);
  if (hit && Date.now() - hit.ts < POOL_TTL_MS) return hit.lines;
  const dataUrl = new URL(file, origin);
  const resp = context.env && context.env.ASSETS
    ? await context.env.ASSETS.fetch(dataUrl)
    : await fetch(dataUrl);
  // 文件缺失/读取失败与「真空池」必须可区分（2026-11-19 审计 M2）：
  // 缺失返回 null，调用方回 502 并带 # data unavailable；文件在但
  // 内容为空返回 []，属正常空池照常 200 返回。
  if (!resp.ok) return null;
  const txt = await resp.text();
  const lines = txt.split("\n").map(s => s.trim()).filter(Boolean);
  poolCache.set(file, { ts: Date.now(), lines });
  return lines;
}

export async function handleSub(context) {
  const url = new URL(context.request.url);
  const q = url.searchParams;
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" };

  const badParam = name => new Response(
    `# 参数错误：${name} 的取值不合法，请检查订阅链接\n`,
    { status: 400, headers });
  // 数值参数严格全串校验（2026-11-17 审计核验 #9）：parseInt/parseFloat 会
  // 部分接受 "1abc"、"1.5x"，拼错的订阅链接被悄悄当成别的值用，排查困难。
  // 一律先过正则全串匹配，非法直接 400（与 mode/group 等参数的既有口径一致）。
  const INT_RE = /^\d+$/;
  const NUM_RE = /^\d+(\.\d+)?$/;
  const uiRaw = q.get("ui");
  let ui = NaN;
  if (uiRaw !== null) {
    if (!INT_RE.test(uiRaw) || Number(uiRaw) < 1) return badParam("ui");
    ui = Number(uiRaw);
  }
  if (!isNaN(ui) && ui > 0) headers["profile-update-interval"] = String(ui);

  // n/rn 上限（2026-11-19 审计 M3）：此前只有下限，n=99999999 这类值
  // 虽然 slice 不出事，但属于明显拼错/滥用，应与其它非法值一样 400。
  // 上限 1000 高于任何单地区实际条数（全池约 1400、单地区最多几百），
  // 正常订阅不受影响。
  const N_MAX = 1000;
  const nRaw = q.get("n");
  const nAll = nRaw !== null && INT_RE.test(nRaw) ? Number(nRaw) : NaN;
  if (nRaw !== null && (isNaN(nAll) || nAll < 1 || nAll > N_MAX)) return badParam("n");
  const carrier = q.get("carrier") || "";
  const carrierSet = new Set(carrier.split(",").map(x => x.trim()).filter(Boolean));
  // carrier 只认四网名（2026-11-19 审计 M3）：此前任意字符串都接受，
  // 拼错一个字就静默给出一份没按运营商过滤的清单，排查困难
  const CARRIERS = new Set(["移动", "电信", "联通", "广电"]);
  for (const c of carrierSet) if (!CARRIERS.has(c)) return badParam("carrier");
  const mode = q.get("mode") || "";
  if (mode && mode !== "random") return badParam("mode");
  if (q.get("stack") !== null && q.get("stack") !== "6") return badParam("stack");
  const group = q.get("group") || "all";
  if (!["best", "full", "extra", "sw", "all"].includes(group)) return badParam("group");
  const fmtRaw = q.get("fmt");
  // fmt= 空串等同未传：空模板进 applyFmt 会把每行名字替换光、只剩裸地址
  // （v1.18 及以前的静默错：参数在但为空 → 节点名全丢且不报错）
  // 纯空白串同理（2026-11-19 审计 M3）：trim 后为空也视为未设
  const fmtClean = fmtRaw === null ? null : fmtRaw.slice(0, 300).replace(/[\r\n]/g, "");
  const fmt = fmtClean === null || fmtClean.trim() === "" ? null : fmtClean;

  // 以下参数校验全部前置于 stack=6 分支（2026-11-19 审计 M3）：此前
  // stack=6 在 regions/ms/mbps/ports/rn 校验之前就直接返回，带着非法
  // 参数的 IPv6 订阅链接会被悄悄当合法链接用。
  const regionsRaw = q.get("regions");
  const regionTokens = (regionsRaw !== null ? regionsRaw : (group === "sw" ? "SW" : "JP,US"))
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  // regions 格式校验：每项必须是两位地区代码（SW 三网专区同为两字母）
  if (!regionTokens.length || regionTokens.some(cc => !/^[A-Z]{2}$/.test(cc)))
    return badParam("regions");
  const regions = new Set(regionTokens);
  const rn = {};
  let rnBad = false;
  (q.get("rn") || "").split(",").forEach(part => {
    if (!part.trim()) return;
    const [cc, v] = part.split(".");
    const num = v && INT_RE.test(v) ? Number(v) : NaN;
    // rn 值非法/为负：整单 400，不再静默吞掉（原实现把 NaN 存进 rn 时
    // slice(0, NaN) 会把该地区悄悄清空，负数则悄悄给空，都难以排查）
    // rn 的地区代码同样过格式校验、数量同样有上限（审计 M3）
    if (!cc || !/^[A-Z]{2}$/.test(cc.trim().toUpperCase())
        || Number.isNaN(num) || num < 0 || num > N_MAX) { rnBad = true; return; }
    rn[cc.trim().toUpperCase()] = num;
  });
  if (rnBad) return badParam("rn");
  // rn 点名的地区并入 regions：只写 rn=HK.5 时 HK 不在缺省 JP,US 里，
  // 不并入就会在下面的池过滤被整地区跳过、一条不出还不报错
  for (const cc of Object.keys(rn)) regions.add(cc);
  const msRaw = q.get("ms");
  const maxMs = msRaw !== null && NUM_RE.test(msRaw) ? Number(msRaw) : NaN;
  if (msRaw !== null && isNaN(maxMs)) return badParam("ms");
  const mbpsRaw = q.get("mbps");
  const minMbps = mbpsRaw !== null && NUM_RE.test(mbpsRaw) ? Number(mbpsRaw) : NaN;
  if (mbpsRaw !== null && isNaN(minMbps)) return badParam("mbps");
  const ports = q.get("ports") || "all";
  if (!["all", "443", "tls"].includes(ports)) return badParam("ports");

  try {
    if (q.get("stack") === "6") {
      let pool = await loadPool(context, url.origin, "/data/all6.txt");
      if (pool === null)
        return new Response("# data unavailable\n", { status: 502, headers });
      if (carrierSet.size) pool = pool.filter(l => { const m = l.match(/·(移动|电信|联通|广电)/); return !m || carrierSet.has(m[1]); });
      if (mode === "random") pool = shuffle(pool);
      const out = isNaN(nAll) ? pool : pool.slice(0, Math.max(0, nAll));
      return new Response(applyFmt(out, fmt).join("\n") + "\n", { headers });
    }

    const pool = await loadPool(context, url.origin, `/data/${group}.txt`);
    if (pool === null)
      return new Response("# data unavailable\n", { status: 502, headers });
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
