#!/usr/bin/env python3
"""注册地补标（scripts/aggregate.py 的 GEO 段）本地替身测试。

跑法：python3 tests/test_geo.py（无网络依赖，lookup 全部打桩）。
覆盖口径：CF 段不查不写、查不到不写、cc 不在白名单不写、运营商
短名归一化、数据库打不开时不覆盖上轮 geo.json。
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import aggregate as agg  # noqa: E402

PASS = 0


def check(name, cond):
    global PASS
    assert cond, f"FAIL: {name}"
    PASS += 1
    print(f"PASS {name}")


# 1) CF 段不查不写：lookup 见到 CF 段 IP 直接抛错，确认根本没被调用
def lookup_boom(ip):
    raise AssertionError(f"CF 段 IP 不应被查询: {ip}")


m = agg.build_geo_map(["172.64.229.7", "104.16.0.1", "162.159.0.1",
                       "198.41.128.1"], lookup_boom)
check("CF 段不查不写", m == {})

# 2) 查得到才写；运营商短名归一化
table = {
    "8.216.44.94": ("JP", "Alibaba (US) Technology Co., Ltd."),
    "47.237.85.7": ("SG", "Alibaba (US) Technology Co., Ltd."),
    "13.193.212.73": ("JP", "Amazon.com, Inc."),
    "8.8.8.8": ("US", "Google LLC"),
}
m = agg.build_geo_map(list(table), lambda ip: table.get(ip))
check("阿里云短名", m["8.216.44.94"] == ["JP", "阿里云"])
check("新加坡阿里云", m["47.237.85.7"] == ["SG", "阿里云"])
check("AWS 短名", m["13.193.212.73"] == ["JP", "AWS"])
check("Google 短名", m["8.8.8.8"] == ["US", "Google Cloud"])

# 3) 查不到不写；lookup 抛异常按查不到处理；cc 不在白名单不写
m = agg.build_geo_map(
    ["1.2.3.4", "5.6.7.8", "9.9.9.9"],
    lambda ip: {"1.2.3.4": None,
                "5.6.7.8": ("XX", "Some Org"),
                "9.9.9.9": (_ for _ in ()).throw(RuntimeError("boom"))}[ip])
check("查不到/坏cc/查询异常都不写", m == {})

# 4) 未知运营商兜底清洗：剥公司后缀、保留可辨认的名字
check("未知 org 剥后缀",
      agg._org_short("Example Hosting LLC") == "Example Hosting")
check("未知 org 剥多层后缀",
      agg._org_short("Foo Bar Technologies, Inc.") == "Foo Bar")
check("空 org 给空串", agg._org_short("") == "" and agg._org_short(None) == "")

# 5) write_geo_json：从总池行抽 IP，只写非 CF 段查得到的
with tempfile.TemporaryDirectory() as td:
    old_data = agg.DATA
    agg.DATA = Path(td)
    try:
        lines = ["8.216.44.94:443#JP [阿里云]", "172.64.229.7:443#US [官方CF]",
                 "47.237.85.7:8443#SG", "203.0.113.9:443#US [文档示例段应被合法性过滤]"]
        n = agg.write_geo_json(lines, lookup=lambda ip: table.get(ip))
        got = json.loads((Path(td) / "geo.json").read_text(encoding="utf-8"))
        check("write_geo_json 条数", n == 2)
        check("write_geo_json 内容",
              got == {"8.216.44.94": ["JP", "阿里云"],
                      "47.237.85.7": ["SG", "阿里云"]})

        # 6) 数据库打不开（lookup=None 且打开失败）→ 抛异常且不覆盖旧文件
        before = (Path(td) / "geo.json").read_text(encoding="utf-8")
        orig_open = agg._open_geo_lookup

        def boom():
            raise RuntimeError("download failed")

        agg._open_geo_lookup = boom
        try:
            agg.write_geo_json(lines)
            raised = False
        except RuntimeError:
            raised = True
        finally:
            agg._open_geo_lookup = orig_open
        check("下载失败抛给调用方", raised)
        check("下载失败不覆盖旧 geo.json",
              (Path(td) / "geo.json").read_text(encoding="utf-8") == before)
    finally:
        agg.DATA = old_data

print(f"\nTOTAL pass={PASS} fail=0")
