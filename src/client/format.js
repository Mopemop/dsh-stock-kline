/**
 * 格式化、涨跌色与视觉常量
 *
 * 纯函数模块：无 DOM、无 React、无网络依赖，可单独测试。
 * 涨跌色按 A 股习惯：红涨绿跌。
 */

function fmtPrice(value, digits) {
  if (value === undefined || value === null || !isFinite(value)) return '--';
  var d = digits === undefined ? 2 : digits;
  return Number(value).toFixed(d);
}

/** 大数按 万/亿 缩写。 */
function fmtLarge(value) {
  if (!isFinite(value) || value === 0) return '--';
  var abs = Math.abs(value);
  if (abs >= 1e8) return (value / 1e8).toFixed(2) + '亿';
  if (abs >= 1e4) return (value / 1e4).toFixed(2) + '万';
  return String(Math.round(value));
}

function fmtPct(value) {
  if (!isFinite(value)) return '--';
  var sign = value > 0 ? '+' : '';
  return sign + value.toFixed(2) + '%';
}

/** 把 K 线日期字符串转成短标签。 */
function shortDate(date) {
  if (typeof date !== 'string') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date.slice(5);
  if (/^\d{4}$/.test(date)) return date.slice(2) + ':' + date.slice(2);
  return date;
}

function dateLabel(date) {
  if (typeof date !== 'string') return '';
  if (/^\d{4}$/.test(date)) return date.slice(0, 2) + ':' + date.slice(2);
  return date;
}

/** 按可见价格区间算 5 个"好看"的刻度。 */
function niceTicks(min, max, count) {
  if (!isFinite(min) || !isFinite(max)) return [];
  if (min === max) return [min];
  var span = max - min;
  var rawStep = span / Math.max(1, count - 1);
  if (!isFinite(rawStep) || rawStep <= 0) return [];
  var magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  var norm = rawStep / magnitude;
  var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude;
  if (!isFinite(step) || step <= 0) return [];
  var start = Math.ceil(min / step) * step;
  var out = [];
  for (var v = start; v <= max + step * 0.001 && out.length < 20; v += step) {
    var value = Number(v.toFixed(10));
    if (isFinite(value)) out.push(value);
  }
  return out;
}

function movingAverage(candles, size) {
  var out = new Array(candles.length).fill(null);
  if (size <= 0) return out;
  var sum = 0;
  for (var i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= size) sum -= candles[i - size].close;
    if (i >= size - 1) out[i] = sum / size;
  }
  return out;
}

/**
 * 涨跌幅基准（昨收）。
 *
 * ## 为什么**优先用倒数第二根收盘**，源给的昨收只作兜底
 *
 * 数据源返回的"昨收"字段并不可靠：实测东财对**指数**返回的 `preKPrice`
 * 与最后一根 K 线完全不自洽（沪深300 给 4593.98，而相邻两根是 4310.28 → 4317.25），
 * 照它算出来是 **-6%** 这种明显错误的涨跌幅。
 *
 * 而"倒数第二根收盘"来自**同一份 K 线数组**，与图上画的东西天然自洽 ——
 * 最后一根可能正是当日那根，所以基准取它前面那根。
 * 只有在拿不到两根 K 线时才退回源给的昨收。
 */
function baselineOf(quote) {
  if (quote === null || quote === undefined) return null;

  var candles = quote.candles;
  if (candles && candles.length >= 2) {
    var previous = candles[candles.length - 2];
    if (previous !== null && previous !== undefined && isFinite(previous.close) && previous.close > 0) {
      return previous.close;
    }
  }

  if (isFinite(quote.preClose) && quote.preClose > 0) return quote.preClose;
  return null;
}

function lastClose(quote) {
  if (quote === null || !quote.candles || quote.candles.length === 0) return null;
  return quote.candles[quote.candles.length - 1].close;
}

/**
 * 可见根数的上下限 —— **主面板与对话背景共用这一份**。
 *
 * 放在这里（而不是 chart.js）是因为现在有两处要用：
 *   · 主面板：滚轮缩放时夹取；
 *   · 对话背景：跟着主面板的缩放画同一段行情，也要能夹。
 * 各写一份必然漂移，所以提到这个双方都依赖的共享模块里。
 *
 * 为什么是这个范围，见 README「滚轮缩放的上下限」：
 *   下限 20 —— 再小蜡烛就与真实步长脱节，网格/均线被拉到极陡，糊成色块；
 *   上限 240 —— 再多就是上千个 SVG 节点，主线程来不及提交画面（黑屏）。
 */
var MIN_VISIBLE_BARS = 20;
var MAX_VISIBLE_BARS = 240;

/** 缩放步长：滚轮一格的倍率。 */
var ZOOM_STEP = 1.15;

/** 默认可见根数（约半年日线）。 */
var DEFAULT_VISIBLE_BARS = 120;

/**
 * 把"想显示多少根"夹到合法范围内。
 *
 * **所有**改可见根数的地方都必须走这里。注意"总数比下限还少"这种情况
 * （新股、短周期、数据源只回了几根）：此时上限就是总数本身，
 * 不能返回一个比总数还大的值。
 */
function clampVisibleBars(count, total) {
  var n = Math.round(Number(count));
  if (!isFinite(total) || total <= 0) return MIN_VISIBLE_BARS;
  if (total <= MIN_VISIBLE_BARS) return total;
  var max = Math.min(total, MAX_VISIBLE_BARS);
  if (!isFinite(n)) n = max;
  return Math.max(MIN_VISIBLE_BARS, Math.min(max, n));
}

/**
 * 按"累积的滚轮步数"算出下一步该显示多少根。
 *
 * 以"当前实际显示根数"（已夹取）为基准，避免在边界上攒出越界的意图值。
 * 步数可正可负（正 = 缩小、负 = 放大），量级正比于这一帧收到的滚轮次数。
 */
function zoomStepsToCount(currentCount, steps, total) {
  var current = clampVisibleBars(currentCount, total);
  return clampVisibleBars(current * Math.pow(ZOOM_STEP, steps), total);
}

/**
 * 视觉常量
 *
 * 写死颜色，不引用主题变量：浮层里主题变量可能解析成与背景接近的灰。
 */

var UP = '#d92d20';
var DOWN = '#12805c';
/** 均线配色（顺序对应 ma 数组下标）。 */
var MA_COLORS = ['#d29922', '#5b9dff', '#c678dd', '#39c5bb'];

var INK = '#111418';
var MUTED = '#5b6470';

/**
 * 文字描边色。
 *
 * 浮窗背景是透明的，而它正好压在**背景皮肤（K 线，50% 不透明度）**上面，
 * 那层浅色罩会把文字"洗淡"。给文字加一圈同色细描边可以在不引入底色的前提下
 * 把笔画加粗一档 —— 这是唯一能在"透明背景"和"字要清楚"之间两全的做法。
 */
var HALO = 'rgba(255,255,255,.9)';

return {
  fmtPrice: fmtPrice,
  fmtLarge: fmtLarge,
  fmtPct: fmtPct,
  shortDate: shortDate,
  dateLabel: dateLabel,
  niceTicks: niceTicks,
  movingAverage: movingAverage,
  baselineOf: baselineOf,
  lastClose: lastClose,
  UP: UP,
  DOWN: DOWN,
  MA_COLORS: MA_COLORS,
  INK: INK,
  MUTED: MUTED,
  HALO: HALO,
  // 缩放策略（主面板与对话背景共用）
  MIN_VISIBLE_BARS: MIN_VISIBLE_BARS,
  MAX_VISIBLE_BARS: MAX_VISIBLE_BARS,
  DEFAULT_VISIBLE_BARS: DEFAULT_VISIBLE_BARS,
  ZOOM_STEP: ZOOM_STEP,
  clampVisibleBars: clampVisibleBars,
  zoomStepsToCount: zoomStepsToCount,
};
