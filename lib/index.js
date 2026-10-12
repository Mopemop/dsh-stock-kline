/**
 * dsh-stock-kline 宿主半侧入口。
 *
 * 职责只有三件事（UI 全在客户端半侧 lib/client.js）：
 *   1. 注册 `/dsh-stock-kline/api/*` 路由，把同花顺/东财行情代理给浏览器
 *      （行情接口没有 CORS 头，浏览器不能直连）。
 *   2. 读写用户偏好（当前代码、周期、均线、挂件开关）到
 *      `~/.dsh/dsh-stock-kline/prefs.json`，让面板换页/重启后仍是同一只股票。
 *   3. 注册一个只读的模型工具 `stock_kline`，让 Agent 也能读同一份行情
 *      （同一套解析，不会出现"图上一个价、模型说另一个价"）。
 *
 * 路由契约（客户端半侧按同一张表调用）：
 *   GET  /dsh-stock-kline/api/quote?symbol=600519&period=day&limit=240
 *        → QuoteResult（同花顺优先，失败自动回落东财，响应里带 source 字段）
 *   GET  /dsh-stock-kline/api/search?q=茅台
 *        → { items:[{ code, name, prefix }] }
 *   GET  /dsh-stock-kline/api/prefs
 *        → { prefs, defaults }
 *   PUT  /dsh-stock-kline/api/prefs   body: 部分偏好对象
 *        → { prefs }
 *   GET  /dsh-stock-kline/api/health
 *        → { ok:true, version }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getQuote, normalizePeriod, searchSymbolList } from './market.js';

export const name = 'dsh-stock-kline';

/** webServer 是硬依赖（没有它就没有取数通道）；tools 用于可选的模型工具。 */
export const inject = ['webServer'];

export const ROUTE_PREFIX = '/dsh-stock-kline/api';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 内置默认偏好：用户没存过 prefs.json 时用它。 */
const DEFAULTS = {
  /**
   * 当前代码，默认沪深300。
   *
   * 指数只走「东财 → 腾讯」：同花顺的 `v6/line` 对指数一律 502/504/404，
   * 而且 `hs_000001` 会被它当成深市个股（返回「平安银行」）。
   */
  symbol: '000300',
  /**
   * 当前周期默认日 K，**不用分时** ——
   * 分时对指数两边都拿不到（同花顺 `v6/time/hs_000300` 直接 404，
   * 东财 1 分钟线也不支持指数），日 K 才能保证"打开就有图"。
   */
  period: 'day',
  /** 均线周期（空数组 = 不画） */
  ma: [5, 10, 20],
  /** 右下角价格挂件是否显示（只有名称与涨跌幅） */
  tickerOpen: true,
  /** 对话页面背景 K 线是否开启 */
  skinOpen: true,
  /**
   * 缩放维度：主面板当前显示多少根 K 线。
   *
   * 存下来是为了"打开就是上次那个缩放"；对话背景读同一个值，
   * 于是背景始终跟主面板画同一段行情。上下限与客户端 format.js 保持一致
   * （这里再夹一次，防止手改 prefs.json 塞进一个畸形值）。
   */
  zoom: 120,
};

/** 可见根数的合法区间（与客户端 format.js 的 MIN/MAX_VISIBLE_BARS 对齐）。 */
const MIN_VISIBLE_BARS = 20;
const MAX_VISIBLE_BARS = 240;

/**
 * 允许写进 prefs.json 的字段与类型（白名单，不认识的键直接丢弃）。
 */
const PREF_SHAPE = {
  symbol: (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined),
  period: (v) => (v === undefined ? undefined : normalizePeriod(v)),
  ma: (v) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 250).slice(0, 6) : undefined),
  tickerOpen: (v) => (typeof v === 'boolean' ? v : undefined),
  skinOpen: (v) => (typeof v === 'boolean' ? v : undefined),
  zoom: (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return undefined;
    return Math.max(MIN_VISIBLE_BARS, Math.min(MAX_VISIBLE_BARS, n));
  },
  // 价格挂件的位置：{ dock: true } 表示贴右下角；带坐标表示用户拖到的自由位置
  tickerBox: (v) => {
    if (v === null || typeof v !== 'object') return undefined;
    if (v.dock !== false) return { dock: true };
    const clamp = (value, min, max, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
    };
    return {
      dock: false,
      x: clamp(v.x, 0, 8000, 16),
      y: clamp(v.y, 0, 8000, 16),
      w: clamp(v.w, 0, 2000, 0),
      h: clamp(v.h, 0, 2000, 0),
    };
  },
};

/** 偏好文件路径（可用 DSH_STOCK_KLINE_HOME 覆盖，便于测试）。 */
export function prefsPath() {
  const home = process.env.DSH_STOCK_KLINE_HOME ?? join(homedir(), '.dsh', 'dsh-stock-kline');
  return join(home, 'prefs.json');
}

/** 读偏好（坏文件只告警并回落默认，绝不让面板打不开）。 */
export function readPrefs() {
  const file = prefsPath();
  if (!existsSync(file)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const out = { ...DEFAULTS };
    for (const [key, coerce] of Object.entries(PREF_SHAPE)) {
      const value = coerce(raw?.[key]);
      if (value !== undefined) out[key] = value;
    }
    return out;
  } catch (error) {
    console.warn('[dsh-stock-kline] prefs.json 读取失败，已回落默认值：' + describe(error));
    return { ...DEFAULTS };
  }
}

/** 写偏好：只写白名单字段，返回合并后的完整偏好。 */
export function writePrefs(patch) {
  const merged = { ...readPrefs() };
  for (const [key, coerce] of Object.entries(PREF_SHAPE)) {
    if (patch === null || typeof patch !== 'object' || !(key in patch)) continue;
    const value = coerce(patch[key]);
    if (value !== undefined) merged[key] = value;
  }
  const file = prefsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 发 JSON 响应。 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 读请求体（有上限，避免被塞爆内存）。 */
async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 路由处理：纯函数式的 (method, url, body) → 响应对象，方便单测直接调用。
 * @param {string} url
 * @param {string} method
 * @param {unknown} body
 */
export async function handleRoute(url, method, body) {
  const parsed = new URL(url, 'http://localhost');
  const path = parsed.pathname.slice(ROUTE_PREFIX.length) || '/';

  if (method === 'GET' && path === '/health') {
    return { status: 200, obj: { ok: true, version: '1.0.0', packageRoot: PACKAGE_ROOT } };
  }

  if (method === 'GET' && path === '/prefs') {
    return { status: 200, obj: { prefs: readPrefs(), defaults: DEFAULTS } };
  }

  if (method === 'PUT' && path === '/prefs') {
    if (body === undefined || body === null || typeof body !== 'object') {
      return { status: 400, obj: { error: 'body 必须是 JSON 对象' } };
    }
    return { status: 200, obj: { prefs: writePrefs(body) } };
  }

  if (method === 'GET' && path === '/search') {
    const q = parsed.searchParams.get('q') ?? '';
    const limit = Math.max(1, Math.min(50, Number(parsed.searchParams.get('limit') ?? 12)));
    const items = await searchSymbolList(q);
    return { status: 200, obj: { items: items.slice(0, limit), query: q } };
  }

  if (method === 'GET' && path === '/quote') {
    const symbol = parsed.searchParams.get('symbol') ?? readPrefs().symbol;
    const period = normalizePeriod(parsed.searchParams.get('period'));
    const limitRaw = Number(parsed.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1500, Math.round(limitRaw)) : undefined;
    try {
      const quote = await getQuote(symbol, period, limit === undefined ? {} : { limit });
      return { status: 200, obj: quote };
    } catch (error) {
      return { status: 502, obj: { error: describe(error) } };
    }
  }

  return { status: 404, obj: { error: `未知路由：${method} ${path}` } };
}

/**
 * Cordis 插件体。
 * @param {any} ctx
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            const body = req.method === 'PUT' || req.method === 'POST' ? await readBody(req) : undefined;
            const result = await handleRoute(req.url ?? '/', req.method ?? 'GET', body);
            sendJson(res, result.status, result.obj);
          } catch (error) {
            sendJson(res, 500, { error: describe(error) });
          }
        },
      }),
    'dsh-stock-kline: /dsh-stock-kline/api routes',
  );

  // 模型工具：只读行情。tools 服务不在场（极简部署）时静默跳过，UI 不受影响。
  ctx.inject?.(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get?.('tools');
    if (tools === undefined || typeof tools.register !== 'function') return;
    tools.register({
      name: 'stock_kline',
      description:
        '读取 A 股实时 K 线行情（数据源：同花顺，失败自动回落东方财富）。' +
        '用于回答股票价格、走势、成交量、均线相关的问题。',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: '股票代码或名称，如 600519 / sh600519 / 贵州茅台' },
          period: {
            type: 'string',
            enum: ['minute', '5', '15', '30', '60', 'day', 'week', 'month'],
            description: '周期：minute=分时，5/15/30/60=分钟 K 线，day/week/month=日周月',
          },
          limit: { type: 'number', description: '返回最近多少根 K 线，默认 60' },
        },
        required: ['symbol'],
      },
      handler: async (args) => {
        const quote = await getQuote(String(args?.symbol ?? ''), normalizePeriod(args?.period), {
          limit: Math.max(5, Math.min(240, Number(args?.limit ?? 60))),
        });
        return {
          symbol: quote.symbol,
          code: quote.code,
          name: quote.name,
          period: quote.period,
          source: quote.source,
          preClose: quote.preClose,
          quote: quote.quote,
          candles: quote.candles.slice(-60),
        };
      },
    });
  });
}
