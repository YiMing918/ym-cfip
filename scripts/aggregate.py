#!/usr/bin/env python3
"""YM 优选 IP 站 · 数据聚合脚本

定时（GitHub Actions 每 2 小时）抓取公开优选源，去重、统一为
「IP:端口#地区 [类型]」格式，生成 data/*.txt + data/meta.json。
只做聚合与格式整理，不做测速——测速口径见各源标注。
"""
import json
import re
import socket
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
CST = timezone(timedelta(hours=8))
UA = {"User-Agent": "Mozilla/5.0 (ym-cfip aggregator)"}

IPV4 = r"\d{1,3}(?:\.\d{1,3}){3}"
NATIVE_RE = re.compile(rf"^({IPV4}):(\d+)#([A-Z]{{2}})\s*(?:\[(.*)\])?\s*$")
LOOSE_RE = re.compile(rf"^({IPV4}):(\d+)")
COLO_RE = re.compile(r"\b([A-Z]{3})\b")
CARRIER_RE = re.compile(r"(移动|电信|联通|广电)")

COLO2CC = {
    "HKG": "HK", "NRT": "JP", "HND": "JP", "KIX": "JP", "ICN": "KR",
    "TPE": "TW", "SIN": "SG", "KUL": "MY", "BKK": "TH", "HAN": "VN",
    "SGN": "VN", "CGK": "ID", "MNL": "PH", "BOM": "IN", "DEL": "IN",
    "LAX": "US", "SJC": "US", "SFO": "US", "SEA": "US", "ORD": "US",
    "DFW": "US", "DAL": "US", "IAD": "US", "EWR": "US", "JFK": "US",
    "MIA": "US", "ATL": "US", "DEN": "US", "PHX": "US", "PDX": "US",
    "SLC": "US", "LAS": "US", "LHR": "GB", "FRA": "DE", "CDG": "FR",
    "AMS": "NL", "SYD": "AU", "MEL": "AU", "GRU": "BR", "YYZ": "CA",
    "YVR": "CA",
}

SOURCES_NATIVE = [
    {
        "key": "best", "name": "实测源 · 高速优选",
        "urls": ["https://ips.gaoji.uk/best_ips.txt",
                 "https://raw.githubusercontent.com/svip-s/cloudflare_ip/refs/heads/main/best_ips.txt"],
        "note": "svip-s/cloudflare_ip，单地区运营商网络实测，源站整点更新",
    },
    {
        "key": "full", "name": "实测源 · 全部可用",
        "urls": ["https://ips.gaoji.uk/full_ips.txt",
                 "https://raw.githubusercontent.com/svip-s/cloudflare_ip/refs/heads/main/full_ips.txt"],
        "note": "同上，全量可用池",
    },
]
SOURCES_LOOSE = [
    {"name": "微测优选", "tag": "微测优选",
     "url": "https://bestcf.tools12345.com/wetest/ipv4.txt"},
    {"name": "CFYes 优选", "tag": "CFYes",
     "url": "https://bestcf.tools12345.com/cfyes/ipv4.txt"},
    {"name": "麒麟优选", "tag": "麒麟优选",
     "url": "https://bestcf.tools12345.com/uouin/all.txt"},
    {"name": "CM 优选", "tag": "CM优选",
     "url": "https://bestcf.tools12345.com/cmliu/all.txt"},
    {"name": "CM 优选 2", "tag": "CM优选",
     "url": "https://bestcf.tools12345.com/cmliu2/all.txt"},
    {"name": "辣椒优选", "tag": "辣椒优选",
     "url": "https://bestcf.tools12345.com/lajiao/all.txt"},
    {"name": "洛璃优选", "tag": "洛璃优选",
     "url": "https://bestcf.tools12345.com/luoli/all.txt"},
    {"name": "Mia 优选", "tag": "Mia优选",
     "url": "https://bestcf.tools12345.com/xinyitang3/ipv4.txt"},
    {"name": "天诚优选", "tag": "天诚优选",
     "url": "https://bestcf.tools12345.com/tiancheng/all.txt"},
    {"name": "天诚优选 2", "tag": "天诚优选",
     "url": "https://bestcf.tools12345.com/tiancheng2/all.txt"},
    {"name": "vvHan 优选", "tag": "vvHan",
     "url": "https://bestcf.tools12345.com/vvhan/ipv4.txt"},
    {"name": "NiREvil 优选", "tag": "NiREvil",
     "url": "https://bestcf.tools12345.com/nirevil/ipv4.txt"},
]

CC_WHITELIST = set("""CN HK TW JP KR SG US GB DE FR NL CA AU IN ID TH VN PH MY AE AR OM KW QA SA EG ZA NG KE BR MX CL PE CO NZ CH SE NO DK FI PL ES IT PT IE BE AT CZ GR TR IL RU UA KZ UZ TM KH LA MM BD PK LK NP PA CR DO GT HN SV NI PR GU VI AS MP UM AL AD AG AO AI AQ AT AW AX AZ BA BB BF BG BH BI BJ BL BM BN BO BQ BS BT BV BW BY BZ CC CD CG CI CK CM CV CW CX CY DJ DM DZ EC EE ER ET FJ FK FM FO GA GD GE GF GH GI GL GM GN GP GQ GS GT GW GY HM HR HT HU IM IO IQ IS JE JM JO KG KI KM KN KP KY LB LC LI LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MN MO MQ MR MT MU MV MW MZ NA NC NE NF NU PF PG PM PN PS PW PY RE RO RS RW SB SC SD SH SI SJ SK SL SM SN SO SR SS ST SX SY SZ TC TD TF TG TJ TK TL TO TT TZ UG UY VC VG VU WF WS YE YT ZM ZW""".split())
# CF 在源文本里是 Cloudflare 的缩写（如 CFnat），不是中非共和国，必须排除
CC_WHITELIST.discard("CF")

# 中文国名 → 地区代码（源只写国名、不写代码时的兜底识别）
CN_NAME2CC = {"日本": "JP", "美国": "US", "新加坡": "SG", "香港": "HK", "台湾": "TW",
              "韩国": "KR", "英国": "GB", "德国": "DE", "法国": "FR", "加拿大": "CA",
              "澳大利亚": "AU", "荷兰": "NL", "印度": "IN", "越南": "VN", "泰国": "TH",
              "马来西亚": "MY", "菲律宾": "PH", "印度尼西亚": "ID", "印尼": "ID",
              "俄罗斯": "RU", "巴西": "BR", "土耳其": "TR", "土库曼斯坦": "TM",
              "哈萨克斯坦": "KZ", "乌克兰": "UA", "西班牙": "ES", "意大利": "IT",
              "瑞士": "CH", "瑞典": "SE", "挪威": "NO", "波兰": "PL", "中国": "CN"}
ZW_RE = re.compile(r"[\u200b\u200c\u200d\u2060\ufeff]")
PRIVATE_RE = re.compile(r"^(127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)")

def valid_ipv4(ip):
    parts = ip.split(".")
    return len(parts) == 4 and all(p.isascii() and p.isdigit() and 0 <= int(p) <= 255 for p in parts)


def valid_port(port):
    return port.isascii() and port.isdigit() and 0 < int(port) <= 65535


def fetch(urls):
    if isinstance(urls, str):
        urls = [urls]
    for url in urls:
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=25) as resp:
                return resp.read().decode("utf-8", "replace"), url
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] fetch failed {url}: {exc}", file=sys.stderr)
    return None, urls[0]


def with_twin(url):
    """BestCF 镜像双主机互为备用：主地址挂了自动换备用域名拉同一份文件。"""
    urls = [url]
    if "bestcf.tools12345.com" in url:
        urls.append(url.replace("bestcf.tools12345.com", "bestcf.pages.dev"))
    return urls


def parse_native(text):
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        m = NATIVE_RE.match(line)
        if m and valid_ipv4(m.group(1)) and valid_port(m.group(2)) and not PRIVATE_RE.match(m.group(1)):
            out.append(line)
    return out


def extract_cc(tail):
    """从源行的尾巴里按段找地区：国名旁的 CC > 3 字母机房码 > 独立 CC 词。"""
    for seg in tail.split("|"):
        seg = seg.strip()
        if not seg:
            continue
        for name, code in CN_NAME2CC.items():
            if name in seg:
                return code
        m = re.search(r"[一-鿿]\s*([A-Z]{2})\b", seg)
        if m and m.group(1) in CC_WHITELIST:
            return m.group(1)
        for colo in COLO_RE.findall(seg):
            if colo in COLO2CC:
                return COLO2CC[colo]
        for tok in re.findall(r"\b([A-Z]{2})\b", seg):
            if tok in CC_WHITELIST:
                return tok
    return None


def parse_loose(text, tag):
    out, sw, skipped = [], [], 0
    for raw in text.splitlines():
        line = ZW_RE.sub("", raw.strip())
        m = LOOSE_RE.match(line)
        if not m:
            continue
        ip, port = m.group(1), m.group(2)
        if PRIVATE_RE.match(ip) or not valid_ipv4(ip) or not (0 < int(port) <= 65535):
            skipped += 1
            continue
        tail = line[m.end():]
        cc = extract_cc(tail)
        carrier = CARRIER_RE.search(tail)
        if not cc:
            # 破例：无地区、但带运营商实测的条目收进「三网专区」（代号 SW）
            if carrier:
                label = tag + f"·{carrier.group(1)}"
                ms = re.search(r"([\d.]+)\s*ms", tail, re.I)
                mb = re.search(r"([\d.]+)\s*(?:mb/s|Mbps)", tail, re.I)
                if ms:
                    label += f" {ms.group(1)}ms"
                if mb:
                    label += f" {mb.group(1)}Mbps"
                sw.append(f"{ip}:{port}#SW [{label}]")
            else:
                skipped += 1
            continue
        label = tag + (f"·{carrier.group(1)}" if carrier else "")
        out.append(f"{ip}:{port}#{cc} [{label}]")
    return out, sw, skipped


def _classify(ip, port, ctx, tag, out, sw):
    """按上下文（地区码 / 运营商）把一条 IP:端口 放进地区池或三网专区。
    测速数字只取本行内的，避免多记录挤页时串到下一条。"""
    cc = extract_cc(ctx)
    carrier = CARRIER_RE.search(ctx)
    first_line = ctx.split("\n", 1)[0]
    ms = re.search(r"([\d.]+)\s*ms", first_line, re.I)
    mb = re.search(r"([\d.]+)\s*(?:mb/s|Mbps)", first_line, re.I)
    met = (f" {ms.group(1)}ms" if ms else "") + (f" {mb.group(1)}Mbps" if mb else "")
    if cc:
        label = tag + (f"·{carrier.group(1)}" if carrier else "") + met
        out.append(f"{ip}:{port}#{cc} [{label}]")
    elif carrier:
        sw.append(f"{ip}:{port}#SW [{tag}·{carrier.group(1)}{met}]")


IPPORT_SCAN_RE = re.compile(r"(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})")
BAREIP_SCAN_RE = re.compile(r"(\d{1,3}(?:\.\d{1,3}){3})(?![:.\d])")
PORT_LABEL_RE = re.compile(r"(?:port|端口)[\"']?\s*[:=]\s*(\d{2,5})", re.I)


def parse_salvage(text, tag):
    """兼容扫描：源站改了版式（CSV / JSON / 表格 / 其他文本布局）时的兜底解析。
    先扫 IP:端口 一体写法；再扫裸 IP（端口从 port 字段 / 紧随数字推断，
    都没有则默认 443）。标注上下文一律取「该 IP 之后 200 字符」——
    记录字段通常写在 IP 后面，向后取窗可避免多记录挤一行时串到上一条。"""
    out, sw, seen = [], [], set()
    flat = text.replace("\r\n", "\n")
    starts, pos = [], 0
    for ln in flat.split("\n"):
        starts.append(pos)
        pos += len(ln) + 1
    lines = flat.split("\n")
    for i, ln in enumerate(lines):
        base = starts[i]
        for m in IPPORT_SCAN_RE.finditer(ln):
            ip, port = m.group(1), int(m.group(2))
            if PRIVATE_RE.match(ip) or not valid_ipv4(ip) or not (0 < port <= 65535):
                continue
            if (ip, port) in seen:
                continue
            seen.add((ip, port))
            _classify(ip, port, flat[base + m.start(): base + m.start() + 200],
                      tag, out, sw)
        for m in BAREIP_SCAN_RE.finditer(ln):
            ip = m.group(1)
            if PRIVATE_RE.match(ip) or not valid_ipv4(ip):
                continue
            after = flat[base + m.start(): base + m.start() + 200]
            pm = PORT_LABEL_RE.search(after)
            if pm:
                port = int(pm.group(1))
            else:
                nm = re.search(r"[,\s](\d{2,5})(?=[,\s]|$)", ln[m.end():])
                port = int(nm.group(1)) if nm else 443
            if not (0 < port <= 65535) or (ip, port) in seen:
                continue
            seen.add((ip, port))
            _classify(ip, port, after, tag, out, sw)
    return out, sw


def parse_uri_list(text, tag):
    """分享链接格式（vmess / vless / trojan）兜底：取 host:port 与备注解析。"""
    import base64 as _b64
    import json as _json
    out, sw = [], []
    for raw in text.splitlines():
        line = raw.strip()
        host = port = remark = None
        try:
            if line.startswith("vmess://"):
                obj = _json.loads(_b64.b64decode(line[8:] + "==").decode("utf-8", "replace"))
                host, port, remark = obj.get("add"), obj.get("port"), obj.get("ps", "")
            elif line.startswith(("vless://", "trojan://")):
                rest = line.split("://", 1)[1]
                remark = rest.rsplit("#", 1)[1] if "#" in rest else ""
                hp = rest.split("@", 1)[-1].split("?")[0].split("#")[0]
                host, _, port = hp.rpartition(":")
        except Exception:  # noqa: BLE001
            continue
        if host and port and re.fullmatch(r"[0-9]{1,3}(?:\.[0-9]{1,3}){3}", str(host)):
            try:
                port_i = int(str(port))
            except (TypeError, ValueError):
                continue
            if PRIVATE_RE.match(str(host)) or not valid_ipv4(str(host)) or not (0 < port_i <= 65535):
                continue
            _classify(str(host), port_i, str(remark), tag, out, sw)
    return out, sw


def parse_loose_any(text, tag):
    """格式自适应：标准 → Base64 解码 → 分享链接 → 兼容扫描，首个有产出的胜出。
    返回 (地区条目, 专区条目, 跳过数, 适配方式)。源站改格式时自动跟上，备注里标明。"""
    import base64 as _b64
    lines, sw, skipped = parse_loose(text, tag)
    if lines or sw:
        return lines, sw, skipped, "标准"
    compact = re.sub(r"\s+", "", text)
    if len(compact) > 40 and re.fullmatch(r"[A-Za-z0-9+/=]+", compact):
        try:
            decoded = _b64.b64decode(compact + "==", validate=False).decode("utf-8", "replace")
            lines, sw, skipped = parse_loose(decoded, tag)
            if not lines and not sw:
                lines, sw = parse_uri_list(decoded, tag)
            if lines or sw:
                return lines, sw, skipped, "Base64 解码"
        except Exception:  # noqa: BLE001
            pass
    lines, sw = parse_uri_list(text, tag)
    if lines or sw:
        return lines, sw, 0, "分享链接解析"
    lines, sw = parse_salvage(text, tag)
    if lines or sw:
        return lines, sw, 0, "兼容扫描"
    return [], [], skipped, "标准"


def number_lines(lines):
    """导出编号：在 #地区 后、方括号前加同地区序号（#JP1、#JP2…）；无地区标注的统一 #IPv6 编号。"""
    cnt, out = {}, []
    for ln in lines:
        m = re.match(r"^(\S+?)#([A-Z]{2})\s*(\[.*)?$", ln)
        if m:
            cc = m.group(2)
            cnt[cc] = cnt.get(cc, 0) + 1
            ln = f"{m.group(1)}#{cc}{cnt[cc]}" + (f" {m.group(3)}" if m.group(3) else "")
        else:
            m6 = re.match(r"^(\S+?)\s*(\[.*)?$", ln)
            if m6:
                cnt["IPv6"] = cnt.get("IPv6", 0) + 1
                ln = f"{m6.group(1)}#IPv6{cnt['IPv6']}" + (f" {m6.group(2)}" if m6.group(2) else "")
        out.append(ln)
    return out


def dedupe(lines):
    seen, out = set(), []
    for line in lines:
        m = LOOSE_RE.match(line)
        key = m.group(0) if m else line
        if key not in seen:
            seen.add(key)
            out.append(line)
    return out


V6_SOURCES = [
    {"name": "CFYes IPv6", "tag": "CFYes",
     "url": "https://bestcf.tools12345.com/cfyes/ipv6.txt"},
    {"name": "vvHan IPv6", "tag": "vvHan",
     "url": "https://bestcf.tools12345.com/vvhan/ipv6.txt"},
    {"name": "NiREvil IPv6", "tag": "NiREvil",
     "url": "https://bestcf.tools12345.com/nirevil/ipv6.txt"},
]
V6_RE = re.compile(r"\[([0-9a-fA-F:]+)\]:(\d+)")
DOMAIN_SOURCES = [
    {"name": "优选域名（svip-s）", "short": "svip-s", "fmt": "hash",
     "url": "https://raw.githubusercontent.com/svip-s/cloudflare_ip/refs/heads/main/domain.txt"},
    {"name": "优选域名（BestCF 全量）", "short": "BestCF", "fmt": "bestcf",
     "url": "https://bestcf.tools12345.com/domain/all.txt"},
    {"name": "优选域名（BestCF 亚洲）", "short": "BestCF亚洲", "fmt": "bestcf",
     "url": "https://bestcf.tools12345.com/domain/Domain-Asia.txt"},
    {"name": "优选域名（cf-nodes）", "short": "cf-nodes", "fmt": "hash",
     "url": "https://raw.githubusercontent.com/wukan1986/cf-nodes/main/best_domains.txt"},
    {"name": "优选域名（cmliu 官方）", "short": "cmliu", "fmt": "bare",
     "default_label": "CF 官方域名",
     "url": "https://raw.githubusercontent.com/cmliu/CF-Pages-BestCF/main/cf_domains.txt"},
    {"name": "优选域名（BestCF 高访问量）", "short": "BestCF高访问量", "fmt": "bare",
     "default_label": "高访问量域名",
     "url": "https://bestcf.tools12345.com/domain/Domain-TOP.txt"},
]
# 各源站自身的更新节奏（页面「数据来源」与 README 展示，本站抓取节奏另见工作流）
CADENCE = {
    "实测源 · 高速优选": "整点更新", "实测源 · 全部可用": "整点更新",
    "美日精选（静态整理）": "静态整理 · 不更新",
    "微测优选": "半小时更新", "CFYes 优选": "半小时更新", "麒麟优选": "约 10 分钟",
    "CM 优选": "半小时更新", "CM 优选 2": "半小时更新", "辣椒优选": "半小时更新",
    "洛璃优选": "半小时更新", "Mia 优选": "半小时更新", "天诚优选": "一天三次",
    "天诚优选 2": "一天三次", "vvHan 优选": "半小时更新", "NiREvil 优选": "每日更新",
    "CFYes IPv6": "半小时更新", "vvHan IPv6": "半小时更新", "NiREvil IPv6": "每日更新",
    "优选域名（svip-s）": "整点更新", "优选域名（BestCF 全量）": "不定期 · 随源站",
    "优选域名（BestCF 亚洲）": "不定期 · 随源站",
    "优选域名（cf-nodes）": "不定期 · 仓库维护",
    "优选域名（cmliu 官方）": "不定期 · 投稿合并",
    "优选域名（BestCF 高访问量）": "不定期 · 随源站",
}
DOM_RE = re.compile(r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$", re.I)


def parse_domains(text, fmt, default_label=""):
    out = []
    for raw in text.splitlines():
        line = ZW_RE.sub("", raw.strip())
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        if re.match(r"^\d{1,3}(\.\d{1,3}){3}", line):
            continue  # IP 行不收（BestCF 全量含官方入口 IP）
        if fmt == "bestcf":
            m = re.match(r"^([A-Za-z0-9.-]+)(?::\d+)?\s*(?:#(.*))?$", line)
            if not m:
                continue
            dom, lab = m.group(1), (m.group(2) or "").strip()
            if "|" in lab:
                lab = lab.split("|")[-1].strip()
            label = lab or default_label
        elif fmt == "hash":
            dom, _, lab = line.partition("#")
            dom = dom.strip().split(":")[0]
            label = lab.strip() or default_label
        else:
            dom, label = line.split()[0], default_label
        dom = dom.strip().lower().rstrip(".")
        if DOM_RE.match(dom):
            out.append((dom, label))
    return out


def resolves(dom):
    try:
        socket.getaddrinfo(dom, 443, proto=socket.IPPROTO_TCP)
        return True
    except Exception:  # noqa: BLE001
        return False


def parse_v6(text, tag):
    out = []
    for raw in text.splitlines():
        line = ZW_RE.sub("", raw.strip())
        m = V6_RE.search(line)
        if not m:
            continue
        carrier = CARRIER_RE.search(line)
        label = tag + (f"·{carrier.group(1)}" if carrier else "")
        out.append(f"[{m.group(1).lower()}]:{m.group(2)} [{label}]")
    return out


def main():
    meta_sources = []
    groups = {}

    for src in SOURCES_NATIVE:
        text, used_url = fetch(src["urls"])
        if text is None:
            meta_sources.append({**{"name": src["name"], "url": src["urls"][0]},
                                 "ok": False, "lines_in": 0, "lines_used": 0,
                                 "note": src["note"]})
            groups[src["key"]] = []
            continue
        lines = dedupe(parse_native(text))
        groups[src["key"]] = lines
        meta_sources.append({"name": src["name"], "url": used_url, "ok": True,
                             "lines_in": len(text.splitlines()),
                             "lines_used": len(lines), "note": src["note"]})

    # 静态精选（人工整理，不随源更新）
    seed = ROOT / "seed-usjp.txt"
    usjp = []
    if seed.exists():
        usjp = dedupe([ln.strip() for ln in
                       seed.read_text(encoding="utf-8").splitlines() if ln.strip()])
    groups["usjp"] = usjp
    meta_sources.append({"name": "美日精选（静态整理）", "url": "", "ok": True,
                         "lines_in": len(usjp), "lines_used": len(usjp),
                         "note": "2026-11-03 多源交叉整理，JP 86 + US 264"})

    extra_all, sw_all = [], []
    for src in SOURCES_LOOSE:
        text, used_url = fetch(with_twin(src["url"]))
        if text is None:
            meta_sources.append({"name": src["name"], "url": src["url"],
                                 "ok": False, "lines_in": 0, "lines_used": 0,
                                 "note": "抓取失败，保留上次数据外本次跳过"})
            continue
        lines, sw_lines, skipped, pmode = parse_loose_any(text, src["tag"])
        extra_all.extend(lines)
        sw_all.extend(sw_lines)
        if not lines and not sw_lines:
            note = ("源内容异常（混入网页代码），本轮自动跳过"
                    if ("<!DOCTYPE" in text or "<html" in text.lower())
                    else "源格式无法识别（可能改版），本轮未收录，已自动尝试 Base64 / 分享链接 / 兼容扫描")
        else:
            note = f"全国源补充；{skipped} 条无地区标注已剔除"
            if sw_lines:
                note += f"；另 {len(sw_lines)} 条无地区但带运营商实测，收进三网专区"
            if pmode != "标准":
                note += f"；源格式已变化，本站以「{pmode}」兼容解析自动适配"
            elif "<!DOCTYPE" in text or "<html" in text.lower():
                note += "；源文件另混有网页代码，相关行已剔除"
        meta_sources.append({"name": src["name"], "url": used_url, "ok": True,
                             "lines_in": len(text.splitlines()),
                             "lines_used": len(lines) + len(sw_lines),
                             "note": note})
    groups["extra"] = dedupe(extra_all)

    merged = dedupe(groups["best"] + groups["usjp"] + groups["extra"] + groups["full"])
    # 三网专区：与总池同地址的以地区版为准，这里只收总池没有的
    merged_addrs = {LOOSE_RE.match(l).group(0) for l in merged if LOOSE_RE.match(l)}
    groups["sw"] = [l for l in dedupe(sw_all)
                    if not LOOSE_RE.match(l) or LOOSE_RE.match(l).group(0) not in merged_addrs]
    groups["all"] = merged + groups["sw"]

    # 今日推荐：高速优选前 20（源内按测速排名）
    top_lines = groups["best"][:20]
    (DATA / "top.txt").write_text("\n".join(number_lines(top_lines)) + "\n", encoding="utf-8")

    group_meta = {
        "best": ("高速优选", "实测源里下载最快的一批，条数少、质量优先"),
        "usjp": ("美日精选", "静态整理：日本 86 + 美国 264（2026-11-03 多源交叉汇编）"),
        "full": ("全部可用", "实测源全量池，条数多，自己再筛"),
        "extra": ("全国补充", "微测 / CFYes / 麒麟 / CM / 辣椒 / 洛璃 / Mia 等源合并去重，全国口径，非单地区专测"),
        "sw": ("三网专区", "无地区标注、但带运营商实测的条目（CFYes / 麒麟 / vvHan 等），破例收录：只有运营商口径、没有地区"),
        "all": ("合并总表", "以上各组合并去重，一份拿全"),
    }
    meta_groups = {}
    for key, lines in groups.items():
        (DATA / f"{key}.txt").write_text("\n".join(number_lines(lines)) + "\n", encoding="utf-8")
        name, note = group_meta[key]
        meta_groups[key] = {"name": name, "count": len(lines),
                            "file": f"data/{key}.txt", "note": note}

    regions = {}
    for line in groups["all"]:
        m = re.search(r"#([A-Z]{2})\b", line)
        if m:
            regions[m.group(1)] = regions.get(m.group(1), 0) + 1
    regions = dict(sorted(regions.items(), key=lambda kv: -kv[1]))

    # IPv6 池（源不带地区标注，单独成池）
    v6_all = []
    for src in V6_SOURCES:
        text, used_url = fetch(with_twin(src["url"]))
        if text is None:
            meta_sources.append({"name": src["name"], "url": src["url"],
                                 "ok": False, "lines_in": 0, "lines_used": 0,
                                 "note": "IPv6 源，抓取失败"})
            continue
        lines = parse_v6(text, src["tag"])
        v6_all.extend(lines)
        meta_sources.append({"name": src["name"], "url": used_url, "ok": True,
                             "lines_in": len(text.splitlines()),
                             "lines_used": len(lines),
                             "note": "IPv6 源，源不带地区标注"})
    v6_all = dedupe(v6_all)
    (DATA / "all6.txt").write_text("\n".join(number_lines(v6_all)) + "\n", encoding="utf-8")

    # 优选域名（多源聚合：合并去重 + DNS 解析筛除失效域名）
    dom_map = {}
    for src in DOMAIN_SOURCES:
        text, used_url = fetch(with_twin(src["url"]))
        if text is None:
            meta_sources.append({"name": src["name"], "url": src["url"], "ok": False,
                                 "lines_in": 0, "lines_used": 0,
                                 "note": "域名源，抓取失败"})
            continue
        pairs = parse_domains(text, src["fmt"], src.get("default_label", ""))
        for dom, label in pairs:
            if dom not in dom_map:
                dom_map[dom] = f"{label} · {src['short']}" if label else f"优选域名 · {src['short']}"
        meta_sources.append({"name": src["name"], "url": used_url, "ok": True,
                             "lines_in": len(text.splitlines()),
                             "lines_used": len(pairs),
                             "note": "优选域名源，与其他域名源合并去重"})
    with ThreadPoolExecutor(max_workers=24) as ex:
        alive = list(ex.map(resolves, list(dom_map.keys())))
    domains, screened = [], 0
    for (dom, lab), ok_ in zip(dom_map.items(), alive):
        if ok_:
            domains.append(f"{dom}#{lab}")
        else:
            screened += 1
    (DATA / "domains.txt").write_text("\n".join(domains) + "\n", encoding="utf-8")
    meta_groups["domains"] = {"name": "优选域名", "count": len(domains),
                               "file": "data/domains.txt",
                               "note": f"{len(DOMAIN_SOURCES)} 个域名源聚合去重，本轮解析筛除 {screened} 个"}

    generated_at = datetime.now(CST).strftime("%Y-%m-%d %H:%M CST")
    for e in meta_sources:
        e["cadence"] = CADENCE.get(e["name"], "—")
        e["fetched_at"] = "—" if e["name"] == "美日精选（静态整理）" else generated_at[11:16]

    # 更新历史（保留最近 30 次）
    hist_file = DATA / "history.json"
    history = []
    if hist_file.exists():
        try:
            history = json.loads(hist_file.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            history = []
    history.insert(0, {"at": generated_at, "total": len(groups["all"]),
                       "v6": len(v6_all),
                       "regions": len([k for k in regions if k != "SW"]),
                       "domains": len(domains)})
    hist_file.write_text(json.dumps(history[:30], ensure_ascii=False, indent=1),
                         encoding="utf-8")

    meta = {
        "generated_at": generated_at,
        "top": {"count": len(top_lines), "file": "data/top.txt"},
        "total": len(groups["all"]),
        "v6_total": len(v6_all),
        "domains_total": len(domains),
        "domains_screened": screened,
        "groups": meta_groups,
        "regions": regions,
        "sources": meta_sources,
    }
    (DATA / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v["count"] for k, v in meta_groups.items()},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
