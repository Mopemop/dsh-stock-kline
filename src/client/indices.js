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
 * ## 为什么 `000001`（上证指数）**不在**这张表里
 *
 * 它在 A 股用户认知里就是深市「平安银行」。裸代码 000001 要留给股票；
 * 想看上证指数请按名称解析（宿主侧 `INDEX_NAMES` 里有这条）。
 *
 * ## `source` 字段的含义
 *
 * 同花顺的 `d.10jqka.com.cn/v6/line/*` 对指数一律 502/504/404，
 * 而且 `hs_000001` 会被它当成深市个股返回「平安银行」——
 * 所以指数一律**跳过同花顺**，走「东财 → 腾讯」。
 */

var INDEXES = [
  { code: '000300', prefix: 'sh', name: '沪深300' },
  { code: '000905', prefix: 'sh', name: '中证500' },
  { code: '000016', prefix: 'sh', name: '上证50' },
  { code: '399001', prefix: 'sz', name: '深证成指' },
  { code: '399006', prefix: 'sz', name: '创业板指' },
  { code: '399005', prefix: 'sz', name: '中小100' },
];

/** 按代码取指数条目（没有就返回 null）。 */
function indexByCode(code) {
  var key = String(code === null || code === undefined ? '' : code).trim();
  for (var i = 0; i < INDEXES.length; i++) {
    if (INDEXES[i].code === key) return INDEXES[i];
  }
  return null;
}

return {
  INDEXES: INDEXES,
  indexByCode: indexByCode,
};
