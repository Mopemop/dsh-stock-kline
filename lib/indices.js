/**
 * 常见指数清单 —— **单一真源**。
 *
 * 客户端那份在 `src/client/indices.js`（bundle 必须自包含，不能 import 这个文件），
 * 由 `scripts/build.mjs` 校验两份完全一致：不一致直接构建失败，
 * 所以不存在"两边漂移"的可能。
 *
 * ## 字段
 *
 *   code    代码。A 股是 6 位数字；**港股/美股不是**（恒生是 `HSI`、道指是 `DJI`）
 *   prefix  市场前缀。`sh`/`sz` 是 A 股，`hk` 港股，`us` 美股
 *   name    显示名
 *   group   面板快捷行的分组：`cn` / `hk` / `us`
 *
 * `prefix + code` 就是腾讯的代码写法，三个市场通用：
 *   sh000300（沪深300）· hkHSI（恒生指数）· usDJI（道琼斯）
 *
 * ## 为什么 A 股指数必须显式列出来
 *
 * **指数和股票共用同一个 6 位数字空间**，光看代码分不出来：
 *
 *   · `000300` 按前缀规则会判成**深市**（取到「万科A」），实际是沪市「沪深300」
 *   · `399001` / `399006` 是深市指数，规则却会按 `3` 开头当创业板个股
 *
 * ## 为什么 `000001`（上证指数）**不在**这张表里
 *
 * 它在 A 股用户认知里就是深市「平安银行」。裸代码 000001 要留给股票；
 * 想看上证指数请按名称解析（`INDEX_NAMES` 里有这条）。
 *
 * ## 数据源（实测结论，不要再凭猜）
 *
 * | 市场 | 日/周/月 K | 分时 | 5·15·30·60 分 |
 * |---|---|---|---|
 * | A 股指数 | 东财 → 腾讯 | 东财 | 东财 |
 * | 港股指数 | **腾讯** | **腾讯** | 由腾讯分时聚合 |
 * | 美股指数 | **腾讯** | **没有** | **没有** |
 *
 *   · 同花顺的 `v6/line` 对指数一律 502/504/404，且 `hs_000001` 会被当成深市
 *     个股返回「平安银行」——所以指数一律**跳过同花顺**。
 *   · 美股指数**没有分钟级数据**：腾讯 `minute/query` 只回一个点，
 *     `kline/kline` 的 m5/m15/m30/m60 也只回一根。所以美股只有日/周/月 K。
 *   · 港股指数的分时是腾讯给的（恒生指数实测 323 个点）。
 */

export const INDEXES = [
  // ── 沪深 ──
  { code: '000300', prefix: 'sh', name: '沪深300', group: 'cn' },
  { code: '000905', prefix: 'sh', name: '中证500', group: 'cn' },
  { code: '000016', prefix: 'sh', name: '上证50', group: 'cn' },
  { code: '399001', prefix: 'sz', name: '深证成指', group: 'cn' },
  { code: '399006', prefix: 'sz', name: '创业板指', group: 'cn' },
  { code: '399005', prefix: 'sz', name: '中小100', group: 'cn' },

  // ── 港股 ──
  { code: 'HSI', prefix: 'hk', name: '恒生指数', group: 'hk' },
  { code: 'HSTECH', prefix: 'hk', name: '恒生科技', group: 'hk' },

  // ── 美股 ──
  { code: 'DJI', prefix: 'us', name: '道琼斯', group: 'us' },
  { code: 'IXIC', prefix: 'us', name: '纳斯达克', group: 'us' },
  { code: 'INX', prefix: 'us', name: '标普500', group: 'us' },
];

/** 按代码取指数条目（没有就返回 undefined）。代码不区分大小写。 */
export function indexByCode(code) {
  const key = String(code ?? '').trim().toLowerCase();
  return INDEXES.find((row) => row.code.toLowerCase() === key);
}
