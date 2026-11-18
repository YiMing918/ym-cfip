// ym-cfip sub 参数解析定向测试（node tests/sub-params.mjs）
// 覆盖 Chief 审计 #3 两个静默错 + #11 补测要求：
//   ① fmt= 空串等同未传（不得把节点名丢光只剩裸地址），与无 fmt 输出一致；
//   ② rn=HK.5 单独使用要把 HK 并入 regions，HK 按 rn 数量出；
//   ③ rn 多地区各自按量取；
//   ④ v1.18 严格校验不回归（n=1abc / rn=JP.1x 回 400），真实 fmt 模板仍生效。
const { onRequest: subRequest } = await import('../functions/sub.js');

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

const POOL = [
  '45.194.17.1:443#HK1 [优选高速 50.1ms 20.5Mbps]',
  '45.194.17.2:443#HK2 [优选高速 51.2ms 19.5Mbps]',
  '45.194.17.3:443#HK3 [优选高速 52.3ms 18.5Mbps]',
  '126.217.78.118:443#JP1 [优选高速 84.34ms 15.55Mbps]',
  '3.113.213.171:443#JP2 [优选高速 84.5ms 11.3Mbps]',
  '172.104.81.253:443#JP3 [优选高速 86.56ms 11.73Mbps]',
  '104.21.5.1:443#US1 [优选高速 150.1ms 25.5Mbps]',
  '104.21.5.2:443#US2 [优选高速 151.2ms 24.5Mbps]',
].join('\n') + '\n';

const subCtx = (qs) => ({
  env: { ASSETS: { fetch: async () => new Response(POOL, { status: 200 }) } },
  request: new Request('http://local/sub' + (qs ? '?' + qs : '')),
});
const lines = async (qs) => {
  const r = await subRequest(subCtx(qs));
  const t = await r.text();
  return { status: r.status, out: t.split('\n').filter(Boolean) };
};
const regionCount = (out, cc) => out.filter(l => l.includes('#' + cc)).length;

// ① fmt= 空值：名字不丢，与无 fmt 的输出逐行一致
{
  const noFmt = await lines('regions=HK');
  const emptyFmt = await lines('regions=HK&fmt=');
  chk('fmt= 空值：200', emptyFmt.status === 200, `status=${emptyFmt.status}`);
  chk('fmt= 空值：每行都带 # 名字（不剩裸地址）', emptyFmt.out.length > 0 && emptyFmt.out.every(l => l.includes('#')), JSON.stringify(emptyFmt.out));
  chk('fmt= 空值：输出与无 fmt 一致', JSON.stringify(emptyFmt.out) === JSON.stringify(noFmt.out));
}

// ② rn=HK.5 单独使用：HK 并入 regions，按 5 取（池里 3 条全出）
{
  const r = await lines('rn=HK.5');
  chk('rn=HK.5：200', r.status === 200, `status=${r.status}`);
  chk('rn=HK.5：HK 出 3 条（池量）', regionCount(r.out, 'HK') === 3, JSON.stringify(r.out));
  chk('rn=HK.5：缺省 JP/US 仍在', regionCount(r.out, 'JP') === 3 && regionCount(r.out, 'US') === 2, JSON.stringify(r.out));
}

// ③ rn 多地区：HK.2,JP.1 各自按量
{
  const r = await lines('rn=HK.2,JP.1');
  chk('rn=HK.2,JP.1：HK 出 2 条', regionCount(r.out, 'HK') === 2, JSON.stringify(r.out));
  chk('rn=HK.2,JP.1：JP 出 1 条', regionCount(r.out, 'JP') === 1, JSON.stringify(r.out));
}

// ④ 严格校验不回归 + 真实模板仍生效
{
  const bad1 = await lines('n=1abc');
  chk('n=1abc → 400（v1.18 校验不回归）', bad1.status === 400, `status=${bad1.status}`);
  const bad2 = await lines('rn=JP.1x');
  chk('rn=JP.1x → 400（v1.18 校验不回归）', bad2.status === 400, `status=${bad2.status}`);
  const tpl = await lines('regions=JP&fmt=' + encodeURIComponent('{代码}-{序号}'));
  chk('fmt 真实模板仍生效', tpl.out.length === 3 && tpl.out.every(l => /#JP-\d$/.test(l)), JSON.stringify(tpl.out));
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
