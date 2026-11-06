#!/usr/bin/env python3
"""YM 优选 IP 站 · 数据聚合脚本

定时（GitHub Actions 每 2 小时）抓取公开优选源，去重、统一为
「IP:端口#地区 [类型]」格式，生成 data/*.txt + data/meta.json。
只做聚合与格式整理，不做测速——测速口径见各源标注。
"""
import json
import re
import sys
import urllib.request
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
]

CC_WHITELIST = set("""CN HK TW JP KR SG US GB DE FR NL CA AU IN ID TH VN PH MY AE AR OM KW QA SA EG ZA NG KE BR MX CL PE CO NZ CH SE NO DK FI PL ES IT PT IE BE AT CZ GR TR IL RU UA KZ UZ TM KH LA MM BD PK LK NP PA CR DO GT HN SV NI PR GU VI AS MP UM AL AD AG AO AI AQ AT AW AX AZ BA BB BF BG BH BI BJ BL BM BN BO BQ BS BT BV BW BY BZ CC CD CG CI CK CM CV CW CX CY DJ DM DZ EC EE ER ET FJ FK FM FO GA GD GE GF GH GI GL GM GN GP GQ GS GT GW GY HM HR HT HU IM IO IQ IS JE JM JO KG KI KM KN KP KY LB LC LI LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MN MO MQ MR MT MU MV MW MZ NA NC NE NF NU PF PG PM PN PS PW PY RE RO RS RW SB SC SD SH SI SJ SK SL SM SN SO SR SS ST SX SY SZ TC TD TF TG TJ TK TL TO TT TZ UG UY VC VG VU WF WS YE YT ZM ZW""".split())
# CF 在源文本里是 Cloudflare 的缩写（如 CFnat），不是中非共和国，必须排除
CC_WHITELIST.discard("CF")
ZW_RE = re.compile(r"[\u200b\u200c\u200d\u2060\ufeff]")
PRIVATE_RE = re.compile(r"^(127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)")


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


def parse_native(text):
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        m = NATIVE_RE.match(line)
        if m:
            out.append(line)
    return out


def extract_cc(tail):
    """从源行的尾巴里按段找地区：国名旁的 CC > 3 字母机房码 > 独立 CC 词。"""
    for seg in tail.split("|"):
        seg = seg.strip()
        if not seg:
            continue
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
    out, skipped = [], 0
    for raw in text.splitlines():
        line = ZW_RE.sub("", raw.strip())
        m = LOOSE_RE.match(line)
        if not m:
            continue
        ip, port = m.group(1), m.group(2)
        if PRIVATE_RE.match(ip) or not (0 < int(port) <= 65535):
            skipped += 1
            continue
        tail = line[m.end():]
        cc = extract_cc(tail)
        if not cc:
            skipped += 1
            continue
        carrier = CARRIER_RE.search(tail)
        label = tag + (f"·{carrier.group(1)}" if carrier else "")
        out.append(f"{ip}:{port}#{cc} [{label}]")
    return out, skipped


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
]
V6_RE = re.compile(r"\[([0-9a-fA-F:]+)\]:(\d+)")
DOMAIN_URLS = ["https://raw.githubusercontent.com/svip-s/cloudflare_ip/refs/heads/main/domain.txt"]


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

    extra_all = []
    for src in SOURCES_LOOSE:
        text, used_url = fetch(src["url"])
        if text is None:
            meta_sources.append({"name": src["name"], "url": src["url"],
                                 "ok": False, "lines_in": 0, "lines_used": 0,
                                 "note": "抓取失败，保留上次数据外本次跳过"})
            continue
        lines, skipped = parse_loose(text, src["tag"])
        extra_all.extend(lines)
        meta_sources.append({"name": src["name"], "url": used_url, "ok": True,
                             "lines_in": len(text.splitlines()),
                             "lines_used": len(lines),
                             "note": f"全国源补充；{skipped} 条无地区标注已剔除"})
    groups["extra"] = dedupe(extra_all)

    merged = dedupe(groups["best"] + groups["usjp"] + groups["extra"] + groups["full"])
    groups["all"] = merged

    # 今日推荐：高速优选前 20（源内按测速排名）
    top_lines = groups["best"][:20]
    (DATA / "top.txt").write_text("\n".join(number_lines(top_lines)) + "\n", encoding="utf-8")

    group_meta = {
        "best": ("高速优选", "实测源里下载最快的一批，条数少、质量优先"),
        "usjp": ("美日精选", "静态整理：日本 86 + 美国 264（2026-11-03 多源交叉汇编）"),
        "full": ("全部可用", "实测源全量池，条数多，自己再筛"),
        "extra": ("全国补充", "微测 / CFYes / 麒麟 / CM / 辣椒 / 洛璃 / Mia 等源合并去重，全国口径，非单地区专测"),
        "all": ("合并总表", "以上四组合并去重，一份拿全"),
    }
    meta_groups = {}
    for key, lines in groups.items():
        (DATA / f"{key}.txt").write_text("\n".join(number_lines(lines)) + "\n", encoding="utf-8")
        name, note = group_meta[key]
        meta_groups[key] = {"name": name, "count": len(lines),
                            "file": f"data/{key}.txt", "note": note}

    regions = {}
    for line in merged:
        m = re.search(r"#([A-Z]{2})\b", line)
        if m:
            regions[m.group(1)] = regions.get(m.group(1), 0) + 1
    regions = dict(sorted(regions.items(), key=lambda kv: -kv[1]))

    # IPv6 池（源不带地区标注，单独成池）
    v6_all = []
    for src in V6_SOURCES:
        text, used_url = fetch(src["url"])
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
                             "note": "IPv6 源（半小时更新），源不带地区标注"})
    v6_all = dedupe(v6_all)
    (DATA / "all6.txt").write_text("\n".join(number_lines(v6_all)) + "\n", encoding="utf-8")

    # 优选域名（svip-s 维护）
    dom_text, _ = fetch(DOMAIN_URLS)
    domains = []
    if dom_text:
        domains = [ln.strip() for ln in dom_text.splitlines()
                   if ln.strip() and not ln.startswith("#")]
    (DATA / "domains.txt").write_text("\n".join(domains) + "\n", encoding="utf-8")
    meta_sources.append({"name": "优选域名（svip-s）", "url": DOMAIN_URLS[0],
                         "ok": bool(domains), "lines_in": len(domains),
                         "lines_used": len(domains),
                         "note": "大厂 CF 域名，可作优选域名/回退入口"})

    generated_at = datetime.now(CST).strftime("%Y-%m-%d %H:%M CST")

    # 更新历史（保留最近 30 次）
    hist_file = DATA / "history.json"
    history = []
    if hist_file.exists():
        try:
            history = json.loads(hist_file.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            history = []
    history.insert(0, {"at": generated_at, "total": len(merged),
                       "v6": len(v6_all), "regions": len(regions),
                       "domains": len(domains)})
    hist_file.write_text(json.dumps(history[:30], ensure_ascii=False, indent=1),
                         encoding="utf-8")

    meta = {
        "generated_at": generated_at,
        "top": {"count": len(top_lines), "file": "data/top.txt"},
        "total": len(merged),
        "v6_total": len(v6_all),
        "domains_total": len(domains),
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
