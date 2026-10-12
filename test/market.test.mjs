// 用真实网络数据验证行情模块：日/周/月/分时/5分钟、名称搜索、兜底路径。
import {
  getQuote,
  normalizePeriod,
  resolveSymbol,
  searchSymbol,
  searchSymbolList,
  parseThsKline,
  unwrapJsonp,
} from '../lib/market.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ' + detail}`);
  if (!ok) failures++;
}

// --- 纯函数 ---
check('normalizePeriod 别名', normalizePeriod('周k') === 'week' && normalizePeriod('1m') === 'minute');
check('normalizePeriod 未知回落 day', normalizePeriod('zzz') === 'day');

const sample =
  '20260105,1356.98,1403.86,1356.98,1397.98,7094942,10018086400.00,0.567,,,0;20260106,1404.53,1408.95,1388.51,1399.99,3958618,5649710200.00,0.316,,,0';
const parsed = parseThsKline(sample);
check('parseThsKline 根数', parsed.length === 2, `got ${parsed.length}`);
check(
  'parseThsKline 字段映射',
  parsed[0].date === '2026-01-05' &&
    parsed[0].open === 1356.98 &&
    parsed[0].high === 1403.86 &&
    parsed[0].low === 1356.98 &&
    parsed[0].close === 1397.98 &&
    Math.round(parsed[0].volume) === 70949,
  JSON.stringify(parsed[0]),
);

check(
  'unwrapJsonp 兼容纯 JSON',
  JSON.stringify(unwrapJsonp('{"a":1}')) === '{"a":1}',
);

// --- 网络：代码归一化 ---
for (const input of ['600519', 'sh600519', '600519.SH', 'hs_600519']) {
  const ref = await resolveSymbol(input);
  check(`resolveSymbol(${input})`, ref.market === 'hs_600519', JSON.stringify(ref));
}
const refByName = await resolveSymbol('贵州茅台').catch((e) => ({ error: e.message }));
check('resolveSymbol(贵州茅台)', refByName.market === 'hs_600519', JSON.stringify(refByName));

// --- 指数：数字空间与股票重叠，必须走显式映射 ---
// 000300 被前缀规则判成深市（会取到万科A），必须显式映射到沪市指数。
// 000001 故意留在股票一侧：A 股用户认知里它就是深市平安银行。
for (const [input, code, prefix] of [
  ['000300', '000300', 'sh'],
  ['399001', '399001', 'sz'],
  ['399006', '399006', 'sz'],
]) {
  const ref = await resolveSymbol(input).catch((e) => ({ error: e.message }));
  check(
    `指数 ${input} 解析到 ${prefix}`,
    ref.code === code && ref.prefix === prefix,
    JSON.stringify(ref),
  );
}
for (const [name, code] of [
  ['沪深300', '000300'],
  ['上证指数', '000001'],
  ['创业板指', '399006'],
]) {
  const ref = await resolveSymbol(name).catch((e) => ({ error: e.message }));
  check(`按名称解析指数「${name}」`, ref.code === code, JSON.stringify(ref));
}

const searchHit = await searchSymbol('平安银行').catch((e) => ({ error: e.message }));
check('searchSymbol(平安银行)', searchHit?.code === '000001', JSON.stringify(searchHit));

const searchPartial = await searchSymbolList('茅台').catch((e) => ({ error: e.message }));
check(
  'searchSymbolList(茅台) 模糊',
  Array.isArray(searchPartial) && searchPartial.some((row) => row.code === '600519'),
  JSON.stringify(searchPartial),
);

const searchCode = await searchSymbol('300750').catch((e) => ({ error: e.message }));
check('searchSymbol(300750)', searchCode?.name === '宁德时代', JSON.stringify(searchCode));

const searchPinyin = await searchSymbol('gzmt').catch((e) => ({ error: e.message }));
check('searchSymbol(gzmt) 拼音', searchPinyin?.code === '600519', JSON.stringify(searchPinyin));

// --- 网络：同花顺各周期 ---
for (const [period, expect] of [
  ['day', 'ths'],
  ['week', 'ths'],
  ['month', 'ths'],
  ['minute', 'ths'],
  ['5', 'ths'],
  ['30', 'ths'],
]) {
  try {
    const q = await getQuote('600519', period);
    const ok =
      q.candles.length > 0 &&
      q.candles.every((c) => Number.isFinite(c.close) && c.close > 0) &&
      q.name.length > 0;
    check(
      `getQuote 600519 ${period}`,
      ok,
      `source=${q.source} name=${q.name} bars=${q.candles.length} last=${JSON.stringify(q.candles.at(-1))} minutes=${q.minutes?.length ?? 0}`,
    );
    check(`  └ ${period} 期望源 ${expect}`, q.source === expect, `source=${q.source}`);
  } catch (error) {
    check(`getQuote 600519 ${period}`, false, error.message);
  }
}

// --- 网络：兜底路径（强制跳过同花顺） ---
try {
  const q = await getQuote('600519', 'day', { only: 'eastmoney' });
  check(
    'getQuote 东财兜底 day',
    q.source === 'eastmoney' && q.candles.length > 0,
    `source=${q.source} name=${q.name} bars=${q.candles.length} last=${JSON.stringify(q.candles.at(-1))}`,
  );
} catch (error) {
  check('getQuote 东财兜底 day', false, error.message);
}

// --- 网络：深市与创业板 ---
for (const code of ['000001', '300750']) {
  try {
    const q = await getQuote(code, 'day');
    check(`getQuote ${code} day`, q.candles.length > 0 && q.name.length > 0, `name=${q.name} bars=${q.candles.length}`);
  } catch (error) {
    check(`getQuote ${code} day`, false, error.message);
  }
}

// --- 失败路径 ---
try {
  await getQuote('999999', 'day');
  check('无效代码应报错', false, '居然成功了');
} catch (error) {
  check('无效代码应报错', true, error.message);
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
