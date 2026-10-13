/**
 * 常见指数清单（客户端与宿主共用一份，避免两边各写一张表以后漂移）
 *
 * ## 为什么需要显式清单
 *
 * **指数和股票共用同一个 6 位数字空间**，光看代码分不出来：
 *
 *   · `000300` 按前缀规则会判成**深市**（取到「万科A」），实际是沪市「沪深300」
 *   · `399001` / `399006` 是深市指数，但规则会按 `3` 开头当创业板个股
 *
 * 所以指数必须白纸黑字列出来。
 *
 * ## 字段
 *
 *   code    代码。A 股是 6 位数字；**港股/美股不是**（恒生 `HSI`、道指 `DJI`）
 *   prefix  市场前缀：`sh`/`sz` A 股，`hk` 港股，`us` 美股
 *   name    显示名
 *   group   面板快捷行的分组：`cn` / `hk` / `us`
 *
 * ## 为什么 `000001`（上证指数）**不在**这张表里
 *
 * 它在 A 股用户认知里就是深市「平安银行」。裸代码 000001 要留给股票；
 * 想看上证指数请按名称解析（宿主侧 `INDEX_NAMES` 里有这条）。
 *
 * ## 数据源（与宿主 `lib/indices.js` 同一份结论）
 *
 *   · 指数一律**跳过同花顺**（它对指数一律 502/504/404）
 *   · A 股指数：东财 → 腾讯；港股/美股指数：**腾讯**
 *   · **美股指数没有分钟级数据**：腾讯只给日/周/月，所以那边只有三个周期可选
 */

var INDEXES = [
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

/** 面板快捷行的分组标题（顺序即显示顺序）。 */
var INDEX_GROUPS = [
  { id: 'cn', label: '沪深' },
  { id: 'hk', label: '港股' },
  { id: 'us', label: '美股' },
];

/** 按代码取指数条目（没有就返回 null）。代码不区分大小写。 */
function indexByCode(code) {
  var key = String(code === null || code === undefined ? '' : code).trim().toLowerCase();
  for (var i = 0; i < INDEXES.length; i++) {
    if (INDEXES[i].code.toLowerCase() === key) return INDEXES[i];
  }
  return null;
}

/**
 * 这里**曾经**有一个 `periodsForCode`，用来把美股指数的分钟周期按钮置灰
 * —— 因为那时美股确实拿不到分钟级数据（腾讯的分时接口只回 1 个点）。
 *
 * 接上东财之后这条不再成立：东财的 klt=1 对美股指数能给满 **390 根**
 * （一个美股交易日），klt=5/15/30/60 也有原生数据；恒生科技虽然东财没有，
 * 但腾讯的分时够用、可以自己聚合成分钟 K 线。
 *
 * 也就是说**每个指数都支持每个周期**，那个限制成了纯粹的谎话，于是删掉。
 * 顺带删掉的是面板上的置灰逻辑、store 里的周期回落，以及它们的样式。
 */

return {
  INDEXES: INDEXES,
  INDEX_GROUPS: INDEX_GROUPS,
  indexByCode: indexByCode,
};
