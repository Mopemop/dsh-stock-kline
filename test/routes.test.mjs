// 宿主路由验证：直接调 handleRoute（不依赖真实 cordis / webServer），并跑一次真网络取数。
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRoute, prefsPath, readPrefs, writePrefs } from '../lib/index.js';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ' + detail}`);
  if (!ok) failures++;
}

// 隔离偏好文件，别动真实用户目录
const sandbox = mkdtempSync(join(tmpdir(), 'dsk-prefs-'));
process.env.DSH_STOCK_KLINE_HOME = sandbox;

check('prefs 路径落在沙箱内', prefsPath().startsWith(sandbox), prefsPath());
const defaults = readPrefs();
check(
  '默认偏好含 symbol/period/ma/tickerOpen/skinOpen',
  defaults.symbol === '000300' &&
    defaults.period === 'day' &&
    Array.isArray(defaults.ma) &&
    defaults.tickerOpen === true &&
    defaults.skinOpen === true,
  JSON.stringify(defaults),
);
check(
  '已删除的偏好字段不再出现（自选股 / 刷新间隔）',
  defaults.watchlist === undefined && defaults.refreshMs === undefined,
  JSON.stringify(Object.keys(defaults)),
);

const written = writePrefs({ symbol: '000001', period: '周k', tickerOpen: false, skinOpen: false, bogus: 1, watchlist: ['000001'] });
check('写入被白名单过滤', written.bogus === undefined && written.watchlist === undefined, JSON.stringify(written));
check('tickerOpen / skinOpen 被接受', written.tickerOpen === false && written.skinOpen === false, JSON.stringify(written));
check('period 被归一化', written.period === 'week', written.period);
check(
  '文件真的落盘且合法 JSON',
  JSON.parse(readFileSync(prefsPath(), 'utf8')).symbol === '000001',
  prefsPath(),
);

// --- 路由 ---
const health = await handleRoute('/dsh-stock-kline/api/health', 'GET');
check('GET /health', health.status === 200 && health.obj.ok === true, JSON.stringify(health.obj));

const prefsGet = await handleRoute('/dsh-stock-kline/api/prefs', 'GET');
check('GET /prefs 回读刚写的值', prefsGet.obj.prefs.symbol === '000001', JSON.stringify(prefsGet.obj.prefs));

const prefsPut = await handleRoute('/dsh-stock-kline/api/prefs', 'PUT', { tickerOpen: true, ma: [5, 20] });
check(
  'PUT /prefs',
  prefsPut.status === 200 && prefsPut.obj.prefs.tickerOpen === true && Array.isArray(prefsPut.obj.prefs.ma),
  JSON.stringify(prefsPut.obj.prefs),
);

const prefsBad = await handleRoute('/dsh-stock-kline/api/prefs', 'PUT', 'not-an-object');
check('PUT /prefs 非法 body → 400', prefsBad.status === 400, String(prefsBad.status));

const unknown = await handleRoute('/dsh-stock-kline/api/nope', 'GET');
check('未知路由 → 404', unknown.status === 404, JSON.stringify(unknown.obj));

const search = await handleRoute('/dsh-stock-kline/api/search?q=' + encodeURIComponent('茅台'), 'GET');
check(
  'GET /search?q=茅台',
  search.status === 200 && search.obj.items.some((row) => row.code === '600519'),
  JSON.stringify(search.obj.items.slice(0, 3)),
);

const quote = await handleRoute('/dsh-stock-kline/api/quote?symbol=600519&period=day&limit=30', 'GET');
check(
  'GET /quote（真网络）',
  quote.status === 200 && quote.obj.source === 'ths' && quote.obj.candles.length === 30,
  `status=${quote.status} source=${quote.obj.source} bars=${quote.obj.candles?.length} name=${quote.obj.name} err=${quote.obj.error ?? ''}`,
);

const quoteBad = await handleRoute('/dsh-stock-kline/api/quote?symbol=999999&period=day', 'GET');
check('GET /quote 无效代码 → 502 且带原因', quoteBad.status === 502 && typeof quoteBad.obj.error === 'string', quoteBad.obj.error);

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
