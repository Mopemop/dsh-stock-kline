/**
 * 行情数据模块 —— 同花顺为主、东方财富兜底。
 *
 * ## 为什么放在宿主侧（Node）而不是浏览器里
 *
 * 1. 两个行情接口都没有 CORS 头，浏览器页面直接 fetch 会被拦；宿主侧没有这个限制。
 * 2. 同花顺的 JSONP 回调名依赖 URL 路径（`quotebridge_v6_line_<sym>_<period>_<year>`），
 *    放在一处解析，主面板和迷你图共用同一份数据，不会出现两套口径。
 * 3. 解析逻辑可以用 node 直接跑真实网络数据验证，不需要浏览器。
 *
 * ## 接口事实（实测确认，不是猜测）
 *
 * ### 同花顺（主源）
 *   K 线   GET https://d.10jqka.com.cn/v6/line/<sym>/<period>/<year>.js
 *          → quotebridge_v6_line_<sym>_<period>_<year>({"data":"...;...;..."})
 *   K 线   GET https://d.10jqka.com.cn/v6/line/<sym>/<period>/last<N>.js
 *          → { year:{...}, total, num, rt, start, name, data, marketType }
 *   分时   GET https://d.10jqka.com.cn/v6/time/<sym>/last.js
 *          → { <sym>:{ name, pre, date, rt, isTrading, data:"0930,价,量,均价,额;..." } }
 *   当日   GET https://d.10jqka.com.cn/v6/line/<sym>/01/today.js
 *          → { <sym>:{ "1":日期, "7":开, "8":高, "9":低, "11":现价, "13":量, "19":额,
 *                      "74":换手?, name, marketType, dt } }
 *   搜索   GET https://searchadapter.eastmoney.com/api/suggest/get?input=<名>&type=14
 *
 *   period 代码：01=日 11=周 21=月 00=前复权日 10=前复权周 20=前复权月
 *   （实测 00/10 与 01/11 的前复权口径一致，本模块统一用 00/10 系列。）
 *
 *   data 每根 K 线 11 段（逗号分隔）：
 *     [0] 日期 YYYYMMDD  [1] 开  [2] 高  [3] 低  [4] 收
 *     [5] 成交量(股)     [6] 成交额(元)  [7] 换手率%  [8][9] 空  [10] 0
 *
 * ### 东方财富（兜底）
 *   GET https://push2his.eastmoney.com/api/qt/stock/kline/get
 *       ?secid=<m>.<code>&klt=<1|5|15|30|60|101|102|103>&fqt=1&lmt=N&end=20500101
 *       &fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61
 *   实测代码不存在时返回 `data: null`（HTTP 仍是 200），所以必须判 data。
 *
 * ## 代码（symbol）归一化
 *   纯 6 位数字按前缀推断交易所（6/5/9 → 沪，0/3/2/1 → 深，4/8 → 北），推断不出来时
 *   把候选都探一遍 today.js，哪个有 name 用哪个；结果按 code 缓存。
 *   已带 `sh`/`sz`/`bj` 前缀或 `.SH` 后缀的写法直接接受；中文名走东财 suggest 反查。
 *
 * ## 类型（本包是纯 ESM JavaScript，不用 TS 语法，这里用 JSDoc 说明形状）
 *
 * @typedef {object} Candle
 * @property {string} date    YYYY-MM-DD
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume  成交量（手，1 手 = 100 股）
 * @property {number} amount  成交额（元）
 *
 * @typedef {object} MinutePoint
 * @property {string} time    HHmm
 * @property {number} price
 * @property {number} average 均价
 * @property {number} volume  成交量（手）
 *
 * @typedef {object} QuoteResult
 * @property {string} symbol
 * @property {string} code
 * @property {string} market              同花顺行情代码，如 hs_600519
 * @property {string} name
 * @property {string} period
 * @property {'ths'|'eastmoney'} source   数据实际由哪个源提供
 * @property {string} [fallbackReason]    主源失败原因（回落时才有）
 * @property {number} [preClose]
 * @property {object} [quote]             当日快照
 * @property {Candle[]} candles
 * @property {MinutePoint[]} [minutes]    period=minute 时才有
 */

export const PERIODS = ['minute', '5', '15', '30', '60', 'day', 'week', 'month'];

/** 同花顺 K 线 period 代码（前复权口径）。 */
const THS_PERIOD = {
  '5': '00',
  '15': '00',
  '30': '00',
  '60': '00',
  day: '00',
  week: '10',
  month: '20',
};

/** 东财 klt。 */
const EM_KLT = { '5': 5, '15': 15, '30': 30, '60': 60, day: 101, week: 102, month: 103 };

/**
 * 港股/美股指数在东财的 `secid`（市场号 100 = 国际指数）。
 *
 * ## 为什么必须写死，不能按前缀推
 *
 * A 股那套 `eastmoneyMarket(prefix)` 只能给出 1（沪）或 0（深）；
 * 国际指数统一是 `100`，代码却各不相同，只能逐个列出。
 *
 * ## 为什么每个都做过交叉验证
 *
 * `100.NDX` 这个代码**名字与内容不符**：东财把它标成「纳斯达克」、
 * 值约 27245（= 纳斯达克综合，对应我们表里的 `IXIC`），
 * 而腾讯的 `usNDX` 才是「纳斯达克100」、值约 30900。
 * 按名字猜就会张冠李戴，所以每个 secid 都用"**同一交易日、两个源收盘价必须相等**"
 * 验过（实测三个美股指数差异均为 0.000%，恒生指数 0.009%）。
 *
 * ## 恒生科技不在这里
 *
 * `100.HSTECH` 返回 `data=null` —— 东财没有这个指数，所以它直接走腾讯
 * （腾讯的分时与 K 线都有它）。
 */
const EM_GLOBAL_SECID = {
  DJI: '100.DJIA',
  IXIC: '100.NDX',
  INX: '100.SPX',
  HSI: '100.HSI',
};

/** 港股/美股指数的 secid（没有就返回 undefined，调用方要走别的源）。 */
function emGlobalSecid(code) {
  return EM_GLOBAL_SECID[String(code ?? '').toUpperCase()];
}

import { INDEXES } from './indices.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const THS_REFERER = 'https://stockpage.10jqka.com.cn/';

/** 请求超时（毫秒）：同花顺偶发 504，必须能快速回落而不是把面板吊死。 */
const DEFAULT_TIMEOUT_MS = 8000;

/** 解析出的交易所缓存：code -> sh/sz/bj。 */
const prefixCache = new Map();

/** 归一化 period（未知值回落 day）。 */
export function normalizePeriod(input) {
  const raw = String(input ?? '')
    .trim()
    .toLowerCase();
  const aliases = {
    '': 'day',
    d: 'day',
    '1d': 'day',
    daily: 'day',
    day: 'day',
    日: 'day',
    日k: 'day',
    日线: 'day',
    w: 'week',
    weekly: 'week',
    week: 'week',
    周: 'week',
    周k: 'week',
    周线: 'week',
    m: 'month',
    monthly: 'month',
    month: 'month',
    月: 'month',
    月k: 'month',
    月线: 'month',
    min: 'minute',
    '1': 'minute',
    '1m': 'minute',
    minute: 'minute',
    分时: 'minute',
    '5m': '5',
    '15m': '15',
    '30m': '30',
    '60m': '60',
  };
  if (PERIODS.includes(raw)) return raw;
  return aliases[raw] ?? 'day';
}

/** 数字安全转换（失败返回 NaN）。 */
function num(value) {
  if (typeof value === 'number') return value;
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** YYYYMMDD -> YYYY-MM-DD。 */
function dash(date) {
  const t = String(date ?? '').trim();
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  return t;
}

/**
 * 连接层失败要不要重试。
 *
 * 实测：东方财富（以及部分 CDN 节点）会主动关掉空闲的 keep-alive 连接，
 * 而 Node 的 fetch（undici）会从连接池里复用那条**已经死掉**的 socket，
 * 于是抛 `TypeError: fetch failed`，cause 是 `UND_ERR_SOCKET`。
 * 这种失败跟请求内容无关，换个新连接就好 —— 但**不重试就会随机失败**，
 * 表现为"同花顺失败、东财也失败"，看起来像数据源全挂了。
 */
function isConnectionError(error) {
  if (error === null || error === undefined) return false;
  const code = error.cause?.code ?? error.code ?? '';
  if (code === 'UND_ERR_SOCKET' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ECONNRESET' || code === 'EPIPE') return true;
  const message = String(error.message ?? '');
  return message === 'fetch failed' || message.includes('socket hang up') || message.includes('other side closed');
}

/**
 * 带超时的 fetch。
 *
 * `Connection: close` 是刻意的：这个插件对同一批行情接口的调用是**低频突发**
 * （切股票、切换周期才发一次），复用连接省下的那点开销远不如"拿到死连接"的代价大。
 */
async function get(url, timeoutMs = DEFAULT_TIMEOUT_MS, referer) {
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    Connection: 'close',
    ...(referer === undefined ? {} : { Referer: referer }),
  };

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return text;
    } catch (error) {
      lastError = error;
      // HTTP 状态错误不重试（重试也不会变）；连接层错误换新连接再试一次
      if (!isConnectionError(error) || attempt === 2) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * 剥掉同花顺的 JSONP 外壳。
 * 回调名随 URL 变化（`quotebridge_v6_line_hs_600519_00_2026(...)`），
 * 所以不匹配具体名字，只取最外层括号内的 JSON。
 */
export function unwrapJsonp(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const start = trimmed.indexOf('(');
  const end = trimmed.lastIndexOf(')');
  if (start < 0 || end <= start) throw new Error('响应不是 JSONP 也不是 JSON');
  return JSON.parse(trimmed.slice(start + 1, end));
}

/** 按 6 位数字前缀推断交易所候选。 */
function candidatesFor(code) {
  if (/^6/.test(code)) return ['sh'];
  if (/^[0321]/.test(code)) return ['sz'];
  if (/^4/.test(code)) return ['bj'];
  // 5/9=沪 B 与基金，8=北交所但深市也有 8 开头的老代码，两边都试
  return ['sh', 'sz', 'bj'];
}

/**
 * 已知指数。
 *
 * 清单来自 `lib/indices.js`（**单一真源**；客户端那份在 `src/client/indices.js`，
 * 由 `scripts/build.mjs` 校验两份一致，不一致直接构建失败）。
 *
 * 为什么必须显式列出来：**指数和股票共用同一个数字空间**，
 * 光看 6 位数字分不出来 —— `000300` 会被前缀规则判成深市（取到「万科A」而不是「沪深300」），
 * `399001` / `399006` 同理。
 *
 * 注意 `000001` **故意不在表里**：它在 A 股用户认知里就是深市「平安银行」，
 * 而沪市「上证指数」也叫 000001。按名称输入「上证指数」仍然能解析到指数
 * （见 INDEX_NAMES），但裸代码优先当股票。
 *
 * 另外：同花顺的 `d.10jqka.com.cn/v6/line/*` 对指数一律 502/504/404，
 * 所以指数走「东财 → 腾讯」，不走同花顺。
 */
/**
 * 已知指数，按**代码**索引。键统一小写 —— 港股/美股代码是字母（`HSI` / `DJI`），
 * 用户可能写成 `hsi` / `hkHSI`，都要能认。
 */
const KNOWN_INDEXES = new Map(
  INDEXES.map((row) => [row.code.toLowerCase(), { code: row.code, prefix: row.prefix, name: row.name, group: row.group }]),
);

/** 这个代码是不是已知指数（不区分大小写）。 */
function isKnownIndex(code) {
  return KNOWN_INDEXES.has(String(code ?? '').trim().toLowerCase());
}

/**
 * 按**名称**查指数。
 *
 * 与 KNOWN_INDEXES 分开，是因为这里有「上证指数 → 000001」这类条目：
 * 它按名称必须能解析，但裸代码 000001 要留给股票（深市平安银行）。
 */
const INDEX_NAMES = new Map(
  [...KNOWN_INDEXES.values(), { code: '000001', prefix: 'sh', name: '上证指数', group: 'cn' }].map((entry) => [
    entry.name.replace(/\s+/g, '').toLowerCase(),
    entry,
  ]),
);

/**
 * 这几个市场是不是**只有腾讯一个源**。
 *
 * 港股/美股指数：同花顺不认（本来就跳过），东财的 secid 市场号没验证过 ——
 * 所以只走腾讯这条实测可用的路，不去猜东财的代码。
 */
function isGlobalIndex(prefix) {
  return prefix === 'hk' || prefix === 'us';
}


/** 探一次 today.js，看这个 code 在该市场是否存在。 */
async function probeMarket(code, timeoutMs) {
  try {
    const text = await get(
      `https://d.10jqka.com.cn/v6/line/hs_${code}/01/today.js`,
      Math.min(timeoutMs, 4000),
      THS_REFERER,
    );
    const body = unwrapJsonp(text);
    const entry = body?.[`hs_${code}`];
    return typeof entry?.name === 'string' && entry.name !== '';
  } catch {
    return false;
  }
}

/**
 * 按代码/名称/拼音搜索（腾讯 smartbox 接口）。
 *
 * 为什么不用东财：实测 `searchadapter.eastmoney.com/api/suggest/get` 不带 `cb` 参数时
 * 返回的是**社区用户搜索**的 JSONP（`result.passportWeb`），拿不到证券代码；
 * 而 `push2.eastmoney.com/api/qt/clist/get` 全量列表接口在连续请求后会被
 * 直接 ECONNRESET（本机实测），不能作为搜索这种高频交互的依赖。
 *
 * 腾讯 smartbox 返回形如：
 *   v_hint="sh~600519~\u8d35\u5dde\u8305\u53f0~gzmt~GP-A"
 * 多行（`^` 分隔）、每行 5 段：市场~代码~名称~拼音~类型。
 *
 * @returns {Promise<Array<{code:string,name:string,prefix:string}>>}
 */
/** 腾讯 smartbox 的名称是字面 `\uXXXX` 转义，解回可读中文。 */
function unescapeUnicode(text) {
  const source = String(text ?? '');
  if (!source.includes('\\u')) return source;
  try {
    return JSON.parse('"' + source.replace(/"/g, '\\"') + '"');
  } catch {
    return source;
  }
}

/**
 * 按关键词搜股票（腾讯 smartbox）。
 *
 * 搜索栏的用途是**找具体个股**（指数有面板上那排快捷按钮，不靠搜索）。
 *
 * 已知限制：smartbox **不认指数** —— `000300` / `399001` / `399006` 返回空，
 * `000905` 还会命中同名个股「厦门港务」。这是有意不处理的：指数走快捷按钮，
 * 搜索只服务个股。
 *
 * @returns {Promise<Array<{code:string,name:string,prefix:string}>>}
 */
export async function searchSymbolList(query, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const q = String(query ?? '').trim();
  if (q === '') return [];
  const url = 'https://smartbox.gtimg.cn/s3/?t=all&q=' + encodeURIComponent(q);
  let text;
  try {
    text = await get(url, Math.min(timeoutMs, 5000), 'https://stockapp.finance.qq.com/');
  } catch {
    return [];
  }
  // v_hint="..."  /  v_hint2="..."  多行用 ^ 分隔
  const quoted = /"([\s\S]*)"/.exec(text);
  if (quoted === null) return [];
  const out = [];
  const seen = new Set();
  for (const row of quoted[1].split('^')) {
    const f = row.split('~');
    if (f.length < 3) continue;
    const rawMarket = String(f[0]).toLowerCase();
    const code = String(f[1]).trim();
    const name = unescapeUnicode(String(f[2]).trim());
    if (!/^\d{6}$/.test(code) || name === '' || seen.has(code)) continue;
    // smartbox 的市场前缀：sh/sz/bj；美股港股等直接跳过（本插件只面向 A 股）
    const prefix = rawMarket === 'sh' ? 'sh' : rawMarket === 'sz' ? 'sz' : rawMarket === 'bj' ? 'bj' : undefined;
    if (prefix === undefined) continue;
    if (f[4] !== undefined && /GP/.test(String(f[4])) === false) continue;
    seen.add(code);
    out.push({ code, name, prefix });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 按代码或名称找一个（先精确代码，再精确名称，最后取第一个结果）。
 * @returns {Promise<{code:string,name:string,prefix:string}|undefined>}
 */
export async function searchSymbol(query, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const raw = String(query ?? '').trim();
  if (raw === '') return undefined;
  const items = await searchSymbolList(raw, timeoutMs);
  if (items.length === 0) return undefined;
  return items.find((row) => row.code === raw) ?? items.find((row) => row.name === raw) ?? items[0];
}

/**
 * 把用户输入归一化成同花顺行情代码。
 *
 * 接受：600519 / sh600519 / SH600519 / 600519.SH / hs_600519 / 贵州茅台 / GZMT
 */
export async function resolveSymbol(input, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const raw = String(input ?? '').trim();
  if (raw === '') throw new Error('股票代码为空');
  const lower = raw.toLowerCase();

  // 指数名称最先查：必须在数字路径**之前** ——
  // 「上证指数」对应的 000001 走裸代码时会命中深市个股，走名称才该拿到指数。
  //
  // ⚠️ 这里**不写 prefixCache**：缓存是按"裸代码"索引的，而同一个代码在不同输入下
  // 可能是两个东西（名称「上证指数」→ 指数 000001，裸代码 000001 → 平安银行）。
  // 写进去会互相污染。
  const wanted = raw.replace(/\s+/g, '').toLowerCase();
  const byIndexName = INDEX_NAMES.get(wanted);
  if (byIndexName !== undefined) {
    // isIndex 一路带下去：名称查到的指数（如「上证指数」→ 000001）不在 KNOWN_INDEXES 里，
    // 下游若只按代码判断就会当成个股、又跑去问同花顺（拿到「平安银行」）。
    return {
      code: byIndexName.code,
      market: marketOf(byIndexName.prefix, byIndexName.code),
      prefix: byIndexName.prefix,
      isIndex: true,
    };
  }

  // 港股/美股指数：代码是字母，写法有好几种 —— `HSI` / `hkHSI` / `hk.HSI`。
  // 必须在数字路径之前处理，否则会被当成拼音去搜股票。
  {
    const global = /^(?:(hk|us)[._-]?)?([a-z][a-z0-9.]{1,9})$/.exec(wanted);
    if (global !== null) {
      const [, prefix, code] = global;
      const hit = KNOWN_INDEXES.get(code);
      if (hit !== undefined && (prefix === undefined || prefix === hit.prefix)) {
        return { code: hit.code, market: marketOf(hit.prefix, hit.code), prefix: hit.prefix, isIndex: true };
      }
    }
  }

  if (/^hs_[a-z]{0,3}\d{6}$/.test(lower)) {
    const code = lower.slice(lower.length - 6);
    const prefix = lower.slice(3, lower.length - 6) || candidatesFor(code)[0];
    return { code, market: `hs_${code}`, prefix };
  }
  const prefixed = /^(sh|sz|bj)[._-]?(\d{6})$/.exec(lower);
  if (prefixed !== null) return { code: prefixed[2], market: `hs_${prefixed[2]}`, prefix: prefixed[1] };

  const suffixed = /^(\d{6})[._-]?(sh|sz|bj)$/.exec(lower);
  if (suffixed !== null) return { code: suffixed[1], market: `hs_${suffixed[1]}`, prefix: suffixed[2] };

  if (/^\d{6}$/.test(raw)) {
    // 指数硬映射要排在**缓存之前**：缓存是按裸代码索引的，而同一个代码
    // 在不同输入下可能是两个东西（名称「上证指数」→ 000001，裸代码 → 平安银行）。
    // 若先读缓存，早先由名称查找写进去的值会污染裸代码的结果。
    const index = KNOWN_INDEXES.get(raw);
    if (index !== undefined) {
      return { code: raw, market: `hs_${raw}`, prefix: index.prefix, isIndex: true };
    }

    const cached = prefixCache.get(raw);
    if (cached !== undefined) return { code: raw, market: `hs_${raw}`, prefix: cached };

    const guesses = candidatesFor(raw);
    if (guesses.length === 1) {
      prefixCache.set(raw, guesses[0]);
      return { code: raw, market: `hs_${raw}`, prefix: guesses[0] };
    }
    for (const prefix of guesses) {
      if (await probeMarket(raw, timeoutMs)) {
        prefixCache.set(raw, prefix);
        return { code: raw, market: `hs_${raw}`, prefix };
      }
    }
    // 探针全部失败（可能只是超时）：用第一个候选照样发请求，让真正的接口去报错
    prefixCache.set(raw, guesses[0]);
    return { code: raw, market: `hs_${raw}`, prefix: guesses[0] };
  }

  const found = await searchSymbol(raw, timeoutMs);
  if (found !== undefined) {
    prefixCache.set(found.code, found.prefix);
    return { code: found.code, market: `hs_${found.code}`, prefix: found.prefix };
  }
  throw new Error(`无法识别的股票代码或名称：${raw}`);
}

/** 解析同花顺 K 线 data 字符串。 */
export function parseThsKline(data) {
  const out = [];
  for (const row of String(data ?? '').split(';')) {
    if (row.trim() === '') continue;
    const f = row.split(',');
    if (f.length < 7) continue;
    const candle = {
      date: dash(f[0]),
      open: num(f[1]),
      high: num(f[2]),
      low: num(f[3]),
      close: num(f[4]),
      // 同花顺给的是股，统一换成手（与东财口径一致）
      volume: num(f[5]) / 100,
      amount: num(f[6]),
    };
    if (!Number.isFinite(candle.open) || candle.open <= 0) continue;
    if (!Number.isFinite(candle.close) || candle.close <= 0) continue;
    if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low)) continue;
    out.push(candle);
  }
  return out;
}

/** 解析东财 klines 行数组。 */
export function parseEastmoneyKline(rows) {
  const out = [];
  for (const row of rows ?? []) {
    const f = String(row).split(',');
    if (f.length < 7) continue;
    const candle = {
      date: dash(f[0]),
      open: num(f[1]),
      close: num(f[2]),
      high: num(f[3]),
      low: num(f[4]),
      volume: num(f[5]),
      amount: num(f[6]),
    };
    if (!Number.isFinite(candle.open) || candle.open <= 0) continue;
    if (!Number.isFinite(candle.close) || candle.close <= 0) continue;
    out.push(candle);
  }
  return out;
}

/** 解析同花顺分时 data。 */
export function parseThsMinutes(data) {
  const out = [];
  for (const row of String(data ?? '').split(';')) {
    if (row.trim() === '') continue;
    const f = row.split(',');
    if (f.length < 4) continue;
    const price = num(f[1]);
    const volume = num(f[2]);
    const amount = num(f[4]);
    if (!Number.isFinite(price) || price <= 0) continue;
    // f[3] 是同花顺自己的均价；缺了就用 额/量 反推（量的单位是股）
    const declared = num(f[3]);
    const average = Number.isFinite(declared) && declared > 0 ? declared : volume > 0 ? amount / volume : price;
    out.push({ time: String(f[0]).padStart(4, '0'), price, average, volume: volume / 100 });
  }
  return out;
}

/** 把 1 分钟点聚合成 N 分钟 K 线（同花顺分时接口只给 1 分钟）。 */
export function aggregateMinutes(points, size) {
  if (size <= 1) {
    return points.map((p) => ({
      date: p.time,
      open: p.price,
      high: p.price,
      low: p.price,
      close: p.price,
      volume: p.volume,
      amount: 0,
    }));
  }
  const out = [];
  for (let i = 0; i < points.length; i += size) {
    const group = points.slice(i, i + size);
    if (group.length === 0) continue;
    let high = group[0].price;
    let low = group[0].price;
    let volume = 0;
    for (const p of group) {
      if (p.price > high) high = p.price;
      if (p.price < low) low = p.price;
      volume += p.volume;
    }
    out.push({
      date: group[0].time,
      open: group[0].price,
      high,
      low,
      close: group[group.length - 1].price,
      volume,
      amount: 0,
    });
  }
  return out;
}

/** 按年向前翻，取够 count 根同花顺 K 线。 */
async function fetchThsKlineByYear(market, code, count, timeoutMs) {
  const thisYear = new Date().getFullYear();
  let name;
  const collected = [];
  const seen = new Set();
  for (let back = 0; back < 15 && collected.length < count; back++) {
    const year = thisYear - back;
    let text;
    try {
      text = await get(`https://d.10jqka.com.cn/v6/line/${market}/${code}/${year}.js`, timeoutMs, THS_REFERER);
    } catch {
      // 某一年缺失（新股 / 接口抖动）不该让整次请求失败
      continue;
    }
    let body;
    try {
      body = unwrapJsonp(text);
    } catch {
      continue;
    }
    if (typeof body?.name === 'string' && name === undefined) name = body.name;
    for (const candle of parseThsKline(body?.data)) {
      if (seen.has(candle.date)) continue;
      seen.add(candle.date);
      collected.push(candle);
    }
  }
  collected.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (collected.length === 0) throw new Error('同花顺没有返回任何 K 线');
  return { name, candles: collected.slice(-count) };
}

/** 同花顺 last1800（一次拿全，含 name）。 */
async function fetchThsKlineBulk(market, code, timeoutMs) {
  const text = await get(`https://d.10jqka.com.cn/v6/line/${market}/${code}/last1800.js`, timeoutMs, THS_REFERER);
  const body = unwrapJsonp(text);
  const candles = parseThsKline(body?.data);
  if (candles.length === 0) throw new Error('同花顺返回的空 K 线');
  return { name: typeof body?.name === 'string' ? body.name : undefined, candles };
}

/**
 * 同花顺当日快照（today.js）。
 *
 * 年度 K 线文件里**没有** name 字段（实测：只有 `{"data":"..."}`），所以股票名与
 * 昨收必须从 today.js 取；一次轻量请求同时解决「面板标题显示代码」和「涨跌幅基准」。
 */
async function fetchThsToday(market, timeoutMs) {
  const text = await get(`https://d.10jqka.com.cn/v6/line/${market}/01/today.js`, timeoutMs, THS_REFERER);
  const t = unwrapJsonp(text)?.[market];
  if (t === undefined) return {};
  return {
    name: typeof t.name === 'string' ? t.name : undefined,
    quote: {
      date: dash(t['1']),
      time: typeof t.dt === 'string' ? t.dt : undefined,
      open: num(t['7']),
      high: num(t['8']),
      low: num(t['9']),
      price: num(t['11']),
      volume: num(t['13']) / 100,
      amount: num(t['19']),
    },
  };
}

/** 取同花顺日/周/月 K 线。 */
async function fetchThsKline(market, period, count, timeoutMs) {
  const code = THS_PERIOD[period];
  if (code === undefined) throw new Error(`同花顺不支持周期 ${period}`);
  // 周/月线一年只有几十根，按年翻页更自然；日线要的多，先试一次 last1800
  if (period === 'day' && count > 300) {
    try {
      const bulk = await fetchThsKlineBulk(market, code, timeoutMs);
      if (bulk.candles.length >= count) return { name: bulk.name, candles: bulk.candles.slice(-count) };
    } catch {
      // 落到按年翻页
    }
  }
  return fetchThsKlineByYear(market, code, count, timeoutMs);
}

/** 取同花顺分时 + 当日快照。 */
async function fetchThsMinute(market, timeoutMs) {
  const [timeText, today] = await Promise.all([
    get(`https://d.10jqka.com.cn/v6/time/${market}/last.js`, timeoutMs, THS_REFERER),
    fetchThsToday(market, timeoutMs).catch(() => ({})),
  ]);

  const body = unwrapJsonp(timeText);
  const entry = body?.[market] ?? Object.values(body ?? {})[0];
  if (entry === undefined) throw new Error('同花顺分时返回结构异常');
  const minutes = parseThsMinutes(entry.data);
  if (minutes.length === 0) throw new Error('同花顺分时没有数据');

  return {
    name: typeof entry.name === 'string' ? entry.name : today.name,
    preClose: num(entry.pre),
    minutes,
    quote: today.quote,
  };
}

/** 东财 secid 市场号。 */
function eastmoneyMarket(prefix) {
  return prefix === 'sh' ? 1 : 0;
}

/**
 * 行情代码（响应里的 `market` 字段）。
 *
 * A 股用同花顺的写法 `hs_600519`；港股/美股指数用腾讯的写法 `hkHSI` / `usDJI`
 * —— 同花顺根本没有这些标的，写 `hs_HSI` 只会误导排查。
 */
function marketOf(prefix, code) {
  return prefix === 'hk' || prefix === 'us' ? `${prefix}${code}` : `hs_${code}`;
}

/** 东财 K 线。 */
async function fetchEastmoney(code, prefix, period, count, timeoutMs) {
  const klt = EM_KLT[period] ?? 101;
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${eastmoneyMarket(prefix)}.${code}` +
    `&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=1&end=20500101&lmt=${Math.max(count, 60)}`;
  const body = JSON.parse(await get(url, timeoutMs));
  if (body?.data === null || body?.data === undefined) throw new Error('东方财富没有该代码的数据');
  const candles = parseEastmoneyKline(body.data.klines);
  if (candles.length === 0) throw new Error('东方财富返回的空 K 线');
  return {
    name: typeof body.data.name === 'string' ? body.data.name : undefined,
    preClose: num(body.data.preKPrice),
    candles: candles.slice(-count),
  };
}

/** 腾讯 K 线的周期名。 */
const TENCENT_PERIOD = { day: 'day', week: 'week', month: 'month' };

/** 解析腾讯 K 线：每根 [日期, 开, 收, 高, 低, 量(手)]。 */
export function parseTencentKline(rows) {
  const out = [];
  for (const row of rows ?? []) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const candle = {
      date: dash(String(row[0]).replace(/-/g, '')),
      open: num(row[1]),
      close: num(row[2]),
      high: num(row[3]),
      low: num(row[4]),
      // 腾讯给的是「手」，同花顺与东财都给「股」——统一成股，否则成交量副图差 100 倍
      volume: num(row[5]) * 100,
      amount: num(row[7]),
    };
    if (!Number.isFinite(candle.open) || candle.open <= 0) continue;
    if (!Number.isFinite(candle.close) || candle.close <= 0) continue;
    out.push(candle);
  }
  return out;
}

/**
 * 腾讯 K 线（指数的兜底源）。
 *
 * 为什么需要它：同花顺的 `d.10jqka.com.cn/v6/line/*` 对**指数**一律 502/504/404，
 * 指数只有东财一个源；而东财的 K 线接口会限流（实测本机被拒：`UND_ERR_SOCKET`）。
 * 腾讯这个接口对 `sh000300` / `sh000001` / `sz399006` 这类指数都稳定可用，
 * 所以指数在"同花顺 → 东财"之外再挂一层保险。
 */
async function fetchTencentKline(code, prefix, period, count, timeoutMs) {
  const span = TENCENT_PERIOD[period];
  if (span === undefined) throw new Error(`腾讯源不支持周期 ${period}`);
  const sym = `${prefix}${code}`;
  const url =
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},${span},,,${Math.max(count, 60)},qfq`;
  const body = JSON.parse(await get(url, timeoutMs));
  const entry = body?.data?.[sym];
  if (entry === null || entry === undefined) throw new Error('腾讯没有该代码的数据');
  // 前复权数据在 qfqday，不带复权时在 day
  const rows = entry.qfqday ?? entry[span] ?? entry.day;
  const candles = parseTencentKline(rows);
  if (candles.length === 0) throw new Error('腾讯返回的空 K 线');
  const qt = entry.qt?.[sym];
  return {
    name: Array.isArray(qt) && typeof qt[1] === 'string' ? qt[1] : undefined,
    preClose: Array.isArray(qt) ? num(qt[4]) : undefined,
    candles: candles.slice(-count),
  };
}

/**
 * 分时至少要这么多点才算"源真的给了分时"。
 *
 * 用来挡住"看起来成功、其实是退化结果"的响应：腾讯对**美股指数**的
 * `minute/query` 只回 1 个点、`kline/kline` 的分钟周期只回 1 根。
 * 港股一天 300+ 个点，A 股 240 个点，所以 10 这个门槛足够宽松又足够拦得住。
 */
const MIN_MINUTE_POINTS = 10;

/**
 * 港股/美股指数 K 线（腾讯 `kline/kline`）。
 *
 * ## 为什么不能复用上面的 `fqkline/get`
 *
 * 实测（2026-10）：
 *
 * | 接口 | `hkHSI` | `usDJI` |
 * |---|---|---|
 * | `fqkline/get?...,qfq` | 61 根 ✅ | **只回 1 根** ❌ |
 * | `usfqkline/get` | — | 60 根 ✅（但只服务美股） |
 * | **`kline/kline`** | 21 根 ✅ | 20 根 ✅ |
 *
 * `kline/kline` 对美股、港股、A 股、指数**全都可用**，所以港股/美股走它。
 * A 股那条路（`fqkline` + 前复权）不动 —— 那个是验证过的，没必要冒险。
 *
 * ## 返回的 data 键名和请求写法**不一致**
 *
 * 美股请求 `usDJI`，回来的键是 `us.DJI`（带点）；港股 `hkHSI` 就还是 `hkHSI`。
 * 所以这里取第一个键，不拼字符串。
 */
async function fetchTencentGlobalKline(code, prefix, period, count, timeoutMs) {
  const span = TENCENT_PERIOD[period];
  if (span === undefined) {
    throw new Error(
      prefix === 'us'
        ? `美股指数没有 ${period} 周期数据（腾讯只提供日/周/月 K）`
        : `腾讯源不支持周期 ${period}`,
    );
  }
  const sym = `${prefix}${code}`;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${sym},${span},,,${Math.max(count, 60)}`;
  const body = JSON.parse(await get(url, timeoutMs));
  const data = body?.data;
  if (data === null || data === undefined) throw new Error('腾讯没有该代码的数据');
  const key = Object.keys(data)[0];
  const entry = data[key];
  if (entry === null || entry === undefined) throw new Error('腾讯没有该代码的数据');
  const candles = parseTencentKline(entry[span] ?? entry.day);
  if (candles.length === 0) throw new Error('腾讯返回的空 K 线');
  const qt = entry.qt?.[key];
  return {
    name: Array.isArray(qt) && typeof qt[1] === 'string' ? qt[1] : undefined,
    preClose: Array.isArray(qt) ? num(qt[4]) : undefined,
    candles: candles.slice(-count),
  };
}

/**
 * 解析腾讯分时（港股指数用）。
 *
 * 每点形如 `"0930 24434.930 292908 2929082925.101"`：
 * `HHmm 价格 累计成交量 累计成交额`（后两个是**累计**值，逐点递增）。
 *
 * 均价同样用**按成交量加权的价格均值**，不能用 `累计额/累计量` ——
 * 港股指数这里两者相除得到的是 10000 这种量级（量的单位与指数点位无关），
 * 跟成分股平均股价一样是**无意义的量**。详见 `parseEastmoneyMinutes` 的注释。
 */
export function parseTencentMinutes(points) {
  const out = [];
  let prevVolume = 0;
  let weightedSum = 0;
  let totalVolume = 0;
  for (const point of points ?? []) {
    const f = String(point).trim().split(/\s+/);
    if (f.length < 3) continue;
    const time = String(f[0]).padStart(4, '0');
    const price = num(f[1]);
    if (!/^\d{4}$/.test(time) || !Number.isFinite(price) || price <= 0) continue;
    const cumulative = num(f[2]);
    // 累计量可能回退（数据修正），那就当这一分钟量为 0，不要出现负量
    const step = Number.isFinite(cumulative) && cumulative > prevVolume ? cumulative - prevVolume : 0;
    if (Number.isFinite(cumulative)) prevVolume = cumulative;
    weightedSum += price * step;
    totalVolume += step;
    out.push({
      time,
      price,
      average: totalVolume > 0 ? weightedSum / totalVolume : price,
      volume: step,
    });
  }
  return out;
}

/** 港股指数分时（腾讯 `minute/query`）。 */
async function fetchTencentMinute(code, prefix, timeoutMs) {
  const sym = `${prefix}${code}`;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${sym}`;
  const body = JSON.parse(await get(url, timeoutMs));
  const node = body?.data?.[sym];
  const raw = node?.data?.data;
  const points = Array.isArray(raw) ? raw : [];
  const minutes = parseTencentMinutes(points);
  if (minutes.length === 0) throw new Error('腾讯返回的空分时');
  const qt = node?.qt?.[sym];
  return {
    name: Array.isArray(qt) && typeof qt[1] === 'string' ? qt[1] : undefined,
    preClose: Array.isArray(qt) ? num(qt[4]) : undefined,
    minutes,
  };
}

/**
 * 把东财 1 分钟 klines 转成分时点（含均价）。
 *
 * 抽成**导出的纯函数**是为了能离线单测：下面那条均价公式踩过坑，
 * 而它不能只靠真网络测试守着 —— 数据源一限流（本机实测经常发生）就测不到了。
 *
 * 均价用**按成交量加权的价格均值**，**不要**用 `Σ成交额 / Σ成交量`。两个原因：
 *
 * 1. **单位对不上**：东财的 `volume` 单位是**手**（1 手 = 100 股），`amount` 是元。
 *    相除得到的是"每手价格" = 股价 × 100 —— 个股上直接差 100 倍。
 *
 * 2. **指数上根本不成立**：指数没有"每股价格"这个概念。它的 `amount` 是成分股
 *    成交额之和、`volume` 是成分股成交量之和，相除得到的是**成分股的平均股价**。
 *    实测沪深300：这个比值为 **2128**，而指数在 **4300** 附近 ——
 *    画出来的均价线会掉到绘图区外面去。
 *
 * 加权价格均值与单位无关（量的量纲自动约掉），个股和指数都对。
 *
 * @param {string[]} klines 东财原始行：日期时间,开,收,高,低,成交量,成交额,…
 * @returns {Array<{time:string,price:number,average:number,volume:number}>}
 */
export function parseEastmoneyMinutes(klines) {
  const rows = Array.isArray(klines) ? klines : [];
  let weightedSum = 0;
  let totalVolume = 0;
  const minutes = [];
  for (const row of rows) {
    const f = String(row).split(',');
    if (f.length < 7) continue;
    // f[2] 是**收盘**价（东财行的顺序是 开,收,高,低）
    const price = num(f[2]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const rawVolume = num(f[5]);
    const volume = Number.isFinite(rawVolume) && rawVolume > 0 ? rawVolume : 0;
    weightedSum += price * volume;
    totalVolume += volume;
    minutes.push({
      time: String(f[0]).slice(11, 16).replace(':', ''),
      price,
      average: totalVolume > 0 ? weightedSum / totalVolume : price,
      volume,
    });
  }
  return minutes;
}

/** 东财 1 分钟线，聚合成均价曲线（兜底分时用）。 */
async function fetchEastmoneyMinute(code, prefix, timeoutMs) {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${eastmoneyMarket(prefix)}.${code}` +
    `&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57` +
    `&klt=1&fqt=1&end=20500101&lmt=300`;
  const body = JSON.parse(await get(url, timeoutMs));
  if (body?.data === null || body?.data === undefined) throw new Error('东方财富没有该代码的分时数据');
  const minutes = parseEastmoneyMinutes(body.data.klines);
  if (minutes.length === 0) throw new Error('东方财富返回的空分时');
  return {
    name: typeof body.data.name === 'string' ? body.data.name : undefined,
    preClose: num(body.data.preKPrice),
    minutes,
  };
}

/**
 * 港股/美股指数走东财（`secid` 写死在 `EM_GLOBAL_SECID`）。
 *
 * ## 为什么值得接这一路
 *
 * 接之前，**美股指数没有分钟级数据**：腾讯的 `minute/query` 只回 1 个点、
 * `kline/kline` 的 m5/m15/m30/m60 只回 1 根。东财这边 klt=1 能给
 * **390 根**（6.5 小时 × 60，正好一个美股交易日），klt=5/15/30/60 也都正常。
 *
 * ## 时间戳是**北京时间**
 *
 * 东财对美股的分钟时间给的是北京时间（`2131 → 0400`，即美东 09:31–16:00）。
 * 会跨午夜，但顺序仍然连续，图上按顺序画没问题 —— 这也正是国内平台看美股的惯例。
 * 港股给的是本地时间（`0930 → 1600`）。
 */
async function fetchEastmoneyGlobal(code, period, count, timeoutMs) {
  const secid = emGlobalSecid(code);
  if (secid === undefined) throw new Error(`东方财富没有 ${code} 这个指数`);
  // 分钟级走 klt=1，取回后由调用方按需聚合；没有 klt=1 的映射项
  const klt = period === 'minute' ? 1 : (EM_KLT[period] ?? 101);
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
    `&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57&klt=${klt}&fqt=1&end=20500101` +
    `&lmt=${Math.max(count, 60)}`;
  const body = JSON.parse(await get(url, timeoutMs));
  if (body?.data === null || body?.data === undefined) {
    throw new Error('东方财富没有该指数的数据');
  }
  return {
    name: typeof body.data.name === 'string' ? body.data.name : undefined,
    preClose: num(body.data.preKPrice),
    // 分钟级别的行与 K 线行是同一套字段，用同一个解析器
    minutes: period === 'minute' ? parseEastmoneyMinutes(body.data.klines) : undefined,
    candles: period === 'minute' ? undefined : parseEastmoneyKline(body.data.klines),
  };
}

/** 把 1 分钟点聚合成 N 分钟 K 线（分钟源只给 1 分钟时用）。 */
function minutesToCandles(minutes, size, count) {
  return aggregateMinutes(minutes, size).slice(-count);
}

/**
 * 分时（`period === 'minute'`）的 K 线数组：**必须与 `minutes` 等长**。
 *
 * 图表的做法是 `minutes.slice(from, from + rows.length)`，而 `from` 是按
 * `candles.length` 推出来的。两者不等长就会**错位** —— 图上的价格折线会跟
 * K 线/坐标轴对不上。
 *
 * 什么时候会不等长：源给的分钟数超过 `count` 时。A 股一天 240 分钟、默认 count
 * 也是 240，正好相等所以一直没暴露；**美股一个交易日是 390 分钟**，一接上东财就会踩到。
 */
function minuteCandles(minutes) {
  return minutesToCandles(minutes, 1, minutes.length);
}

/**
 * 取行情：同花顺优先，任何失败都回落东方财富。
 *
 * 只有两个源都失败才抛错，错误信息里带两边各自的原因。
 *
 * @param {string} symbol
 * @param {string} period
 * @param {{ limit?: number, timeoutMs?: number, only?: 'ths'|'eastmoney' }} [options]
 * @returns {Promise<QuoteResult>}
 */
export async function getQuote(symbol, period, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const count = options.limit ?? 240;
  const ref = await resolveSymbol(symbol, timeoutMs);

  /**
   * 港股/美股指数：**东财 → 腾讯**。
   *
   * 这两类标的不进"同花顺 → 东财 → 腾讯"那条链 —— 同花顺根本没有它们
   * （`hs_HSI` 这种东西不存在），所以只有两个源。
   *
   * 东财这一路是后加的，值得说清楚为什么：接它之前**美股指数没有分钟级数据**
   * （腾讯的 `minute/query` 只回 1 个点、m5/m15/m30/m60 只回 1 根），
   * 所以那时面板把美股的分钟按钮置灰了。加上东财之后不再需要那个限制：
   * 它的 klt=1 能给满 390 根（一个美股交易日），klt=5/15/30/60 也正常。
   *
   * secid 逐个验过（见 `EM_GLOBAL_SECID` 的注释）；恒生科技东财没有，
   * 所以它 `emGlobalSecid` 返回 undefined、直接落到腾讯。
   */
  if (isGlobalIndex(ref.prefix)) {
    const base = { symbol, code: ref.code, market: ref.market, period };
    let emError;
    if (emGlobalSecid(ref.code) !== undefined) {
      try {
        // 东财对 5/15/30/60 有**原生** klt，所以除 `minute` 外直接拿 candles，
        // 不要绕道"先取 1 分钟再聚合"（那样既多请求又不如源自己聚合得准）
        const got = await fetchEastmoneyGlobal(ref.code, period, count, timeoutMs);
        const withEm = Object.assign({}, base, {
          name: got.name ?? ref.code,
          source: 'eastmoney',
          preClose: Number.isFinite(got.preClose) ? got.preClose : undefined,
        });
        if (period === 'minute') {
          return Object.assign(withEm, { candles: minuteCandles(got.minutes), minutes: got.minutes });
        }
        return Object.assign(withEm, { candles: got.candles });
      } catch (error) {
        emError = error instanceof Error ? error.message : String(error);
      }
    }
    const emReason = emError === undefined ? '东方财富：未尝试' : `东方财富：${emError}`;
    const withTc = Object.assign({}, base, { source: 'tencent', fallbackReason: emReason });
    try {
      if (period === 'minute') {
        const got = await fetchTencentMinute(ref.code, ref.prefix, timeoutMs);
        /**
         * 点数太少说明源其实没给分时，而不是"当天的行情特别短"——
         * 腾讯对**美股**指数就是这个症状（只回 1 个点）。宁可报错，
         * 也不要画一条只有一个点的分时线（那比明确失败更让人困惑）。
         * （美股实际会先走东财；只有东财挂了才落到这里。）
         */
        if (got.minutes.length < MIN_MINUTE_POINTS) {
          throw new Error(`分时数据不足（只有 ${got.minutes.length} 个点）`);
        }
        return Object.assign(withTc, {
          name: got.name ?? ref.code,
          preClose: Number.isFinite(got.preClose) ? got.preClose : undefined,
          candles: minuteCandles(got.minutes),
          minutes: got.minutes,
        });
      }
      if (period === '5' || period === '15' || period === '30' || period === '60') {
        // 腾讯不提供分钟 K 线，只有分时 → 自己聚合
        const got = await fetchTencentMinute(ref.code, ref.prefix, timeoutMs);
        if (got.minutes.length < MIN_MINUTE_POINTS) {
          throw new Error(`分时数据不足（只有 ${got.minutes.length} 个点，无法聚合 ${period} 分钟）`);
        }
        return Object.assign(withTc, {
          name: got.name ?? ref.code,
          preClose: Number.isFinite(got.preClose) ? got.preClose : undefined,
          candles: minutesToCandles(got.minutes, Number(period), count),
          minutes: got.minutes,
        });
      }
      const got = await fetchTencentGlobalKline(ref.code, ref.prefix, period, count, timeoutMs);
      return Object.assign(withTc, {
        name: got.name ?? ref.code,
        preClose: Number.isFinite(got.preClose) ? got.preClose : undefined,
        candles: got.candles,
      });
    } catch (error) {
      const tcError = error instanceof Error ? error.message : String(error);
      throw new Error(
        emError === undefined
          ? `腾讯失败（${tcError}）`
          : `东方财富失败（${emError}）；腾讯失败（${tcError}）`,
      );
    }
  }

  let thsError;
  // 指数跳过同花顺：它的 v6/line 接口对指数一律 502/504/404，而且 `hs_000001`
  // 会被它当成深市个股（返回「平安银行」而不是「上证指数」）——直接不用它。
  const skipThs = options.only === 'eastmoney' || ref.isIndex === true || isKnownIndex(ref.code);
  if (!skipThs) {
    try {
      if (period === 'minute') {
        const got = await fetchThsMinute(ref.market, timeoutMs);
        return {
          symbol,
          code: ref.code,
          market: ref.market,
          name: got.name ?? ref.code,
          period,
          source: 'ths',
          preClose: Number.isFinite(got.preClose) ? got.preClose : undefined,
          quote: got.quote,
          candles: minuteCandles(got.minutes),
          minutes: got.minutes,
        };
      }
      if (period === '5' || period === '15' || period === '30' || period === '60') {
        const got = await fetchThsMinute(ref.market, timeoutMs);
        return {
          symbol,
          code: ref.code,
          market: ref.market,
          name: got.name ?? ref.code,
          period,
          source: 'ths',
          preClose: Number.isFinite(got.preClose) ? got.preClose : undefined,
          quote: got.quote,
          candles: minutesToCandles(got.minutes, Number(period), count),
          minutes: got.minutes,
        };
      }
      const got = await fetchThsKline(ref.market, period, count, timeoutMs);
      // 名称与昨收只能从 today.js 拿（年度 K 线文件不含 name）
      const today = await fetchThsToday(ref.market, timeoutMs).catch(() => ({}));
      return {
        symbol,
        code: ref.code,
        market: ref.market,
        name: got.name ?? today.name ?? ref.code,
        period,
        source: 'ths',
        quote: today.quote,
        candles: got.candles,
      };
    } catch (error) {
      thsError = error instanceof Error ? error.message : String(error);
    }
  }

  if (options.only === 'ths') throw new Error(`同花顺失败：${thsError}`);

  try {
    if (period === 'minute') {
      const got = await fetchEastmoneyMinute(ref.code, ref.prefix, timeoutMs);
      return {
        symbol,
        code: ref.code,
        market: ref.market,
        name: got.name ?? ref.code,
        period,
        source: 'eastmoney',
        fallbackReason: thsError,
        preClose: Number.isFinite(got.preClose) ? got.preClose : undefined,
        candles: minuteCandles(got.minutes),
        minutes: got.minutes,
      };
    }
    const got = await fetchEastmoney(ref.code, ref.prefix, period, count, timeoutMs);
    return {
      symbol,
      code: ref.code,
      market: ref.market,
      name: got.name ?? ref.code,
      period,
      source: 'eastmoney',
      fallbackReason: thsError,
      preClose: Number.isFinite(got.preClose) ? got.preClose : undefined,
      candles: got.candles,
    };
  } catch (error) {
    const emError = error instanceof Error ? error.message : String(error);
    if (options.only === 'eastmoney') {
      throw new Error(`同花顺失败（${thsError ?? '未尝试'}）；东方财富失败（${emError}）`);
    }
    /**
     * 第三层：腾讯。这一层要**按周期分流**。
     *
     * 东财的 K 线接口会限流（本机实测经常被拒），它是 A 股指数**分时**的唯一来源
     * —— 一旦被限流，指数分时就成了空白。而腾讯的 `minute/query` 实测对
     * A 股指数与个股**都可用**（沪深300 242 个点、贵州茅台 267 个点），
     * 所以分钟级周期要在这里走分时接口，而不是拿 K 线接口去撞
     * "腾讯源不支持周期 minute"。
     */
    const minuteLike = period === 'minute' || period === '5' || period === '15' || period === '30' || period === '60';
    try {
      if (minuteLike) {
        const got = await fetchTencentMinute(ref.code, ref.prefix, timeoutMs);
        if (got.minutes.length < MIN_MINUTE_POINTS) {
          throw new Error(`分时数据不足（只有 ${got.minutes.length} 个点）`);
        }
        return {
          symbol,
          code: ref.code,
          market: ref.market,
          name: got.name ?? ref.code,
          period,
          source: 'tencent',
          fallbackReason: `同花顺：${thsError ?? '未尝试'}；东方财富：${emError}`,
          preClose: Number.isFinite(got.preClose) ? got.preClose : undefined,
          candles: minutesToCandles(got.minutes, period === 'minute' ? 1 : Number(period), count),
          minutes: got.minutes,
        };
      }
      const got = await fetchTencentKline(ref.code, ref.prefix, period, count, timeoutMs);
      return {
        symbol,
        code: ref.code,
        market: ref.market,
        name: got.name ?? ref.code,
        period,
        source: 'tencent',
        fallbackReason: `同花顺：${thsError ?? '未尝试'}；东方财富：${emError}`,
        preClose: Number.isFinite(got.preClose) ? got.preClose : undefined,
        candles: got.candles,
      };
    } catch (tencentError) {
      const tcError = tencentError instanceof Error ? tencentError.message : String(tencentError);
      throw new Error(
        `同花顺失败（${thsError ?? '未尝试'}）；东方财富失败（${emError}）；腾讯失败（${tcError}）`,
      );
    }
  }
}
