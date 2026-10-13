/**
 * dsh-stock-kline 浏览器半侧 bundle —— **构建产物，请勿直接编辑**。
 *
 * 源码在 src/client/ 下按模块拆分，重新生成：node scripts/build.mjs
 *
 * 模块（顺序 = 初始化顺序）：
 *   format.js       格式化、涨跌色与视觉常量（纯函数）
 *   prefs.js        偏好读写（浏览器本地存储为主，尽力同步宿主）
 *   indices.js      常见指数清单（与宿主 lib/indices.js 同源）
 *   styles.js       样式注入（CSS 文本在 styles/client.css）
 *   market.js       行情状态中心 store + 订阅 Hook
 *   chart.js        自绘 SVG K 线图
 *   ticker.js       价格挂件（透明小标签：名称 + 涨跌百分比）
 *   skin.js         对话页背景 K 线（DOM 注入）
 *   chart-panel.js  行情主面板（指数快捷行 + 整页大图）
 *   plugin.js       插件入口：槽位注册与生命周期
 */
window.__ModuleLoader__.load({
  id: 'dsh-stock-kline',
  factory: function (require) {
    /** 模块表：按 MODULES 顺序初始化，前一个可以是后一个的依赖。 */
    var __factories = {};
    var __cache = {};
    function R(name) {
      if (Object.prototype.hasOwnProperty.call(__cache, name)) return __cache[name];
      var factory = __factories[name];
      if (factory === undefined) throw new Error('未知模块：' + name);
      var exports = factory();
      __cache[name] = exports;
      return exports;
    }

    // ===================== format =====================
    __factories["format"] = function () {
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
    };

    // ===================== prefs =====================
    __factories["prefs"] = function () {
  /**
   * 偏好读写
   *
   * 以浏览器本地存储为**主存储**：宿主那半边的字段白名单是进程启动时加载的，
   * 插件升级后不重启 DSH 就不认识新字段，所以本地存储才是「下次打开还认得」的来源。
   * 宿主同步尽力而为，失败不影响使用。
   */

  var API = '/dsh-stock-kline/api';

  var LOCAL_KEY = 'dsh-stock-kline:prefs';

  /** 会被持久化的偏好字段（客户端与宿主共用同一张表）。 */
  var PREF_KEYS = ['symbol', 'period', 'ma', 'tickerOpen', 'skinOpen', 'tickerBox', 'zoom'];

  function loadLocalPrefs() {
    try {
      var raw = window.localStorage.getItem(LOCAL_KEY);
      return raw === null ? {} : JSON.parse(raw);
    } catch (error) {
      return {};
    }
  }

  function saveLocalPrefs(prefs) {
    try {
      window.localStorage.setItem(LOCAL_KEY, JSON.stringify(prefs));
    } catch (error) {
      /* 隐私模式等场景静默忽略 */
    }
  }

  return {
    API: API,
    LOCAL_KEY: LOCAL_KEY,
    PREF_KEYS: PREF_KEYS,
    loadLocalPrefs: loadLocalPrefs,
    saveLocalPrefs: saveLocalPrefs,
  };
    };

    // ===================== indices =====================
    __factories["indices"] = function () {
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
    };

    // ===================== styles =====================
    __factories["styles"] = function () {
  /**
   * 样式注入。
   *
   * CSS 文本放在同目录的 `styles/client.css`，由构建脚本内联进 bundle
   * （DSH 客户端 bundle 必须自包含，不能运行时再发一次请求）。
   *
   * ## 两条硬约定（都是踩过的坑）
   *
   * 1. **每一条 CSS 都是完整规则**（选择器 + 收尾 `}`）。曾经按行清理旧样式，
   *    把多行拼接的规则拦腰截断，留下孤儿属性碎片；CSS 解析器遇到碎片会一路吞
   *    token 直到下一个 `;`/`}`，把紧随其后的整条规则吃掉 —— 表现就是
   *    「挂件纯白、文字全看不见」。所以 CSS 现在独立成 .css 文件，不再手拼字符串。
   *
   * 2. **`STYLE_TAG` 带版本号**。注入按 `data-plugin-css` 去重，沿用同一个 id 时
   *    页面上旧版本写的 `<style>` 会把新样式整体挡住（刷新也救不回来，因为新规则
   *    根本进不了 DOM）。**每次改样式都要提升版本号。**
   */
  var STYLE_TAG = 'dsh-stock-kline/client.v10.css';

  /** 由构建脚本替换为真正的 CSS 文本。 */
  var STYLE_TEXT = ".dsk-root{box-sizing:border-box;height:100%;min-height:280px;width:100%;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);overflow:hidden}\n/* 头部三行：行情 / 工具 / 快捷指数。\n   每行单一职责，换行只发生在组**内部** —— 不再让整块靠 flex-wrap 随机洗牌。 */\n.dsk-head{display:flex;flex-direction:column;gap:8px;padding:14px clamp(12px,2vw,24px) 10px}\n/* macOS 的标题栏是覆盖式（红绿灯按钮压在内容上），所以头部要额外让出顶部间隙 */\n[data-platform=darwin] .dsk-head{padding-top:calc(14px + var(--dsh-frame-top-clearance,0px))}\n/* ① 行情行：左“看什么/多少钱”，右“数据可不可信”（来源+时间） */\n.dsk-quoteRow{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-height:26px}\n.dsk-meta{display:flex;align-items:center;gap:6px;flex:none}\n/* ② 工具行：左选择（周期）｜右动作（搜索/刷新/开关），中间竖线分组 */\n.dsk-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;row-gap:6px}\n.dsk-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}\n.dsk-vsep{width:1px;flex:none;align-self:stretch;min-height:22px;background:var(--dsw-alias-border-l1)}\n.dsk-title{display:flex;align-items:baseline;gap:8px;min-width:0}\n.dsk-name{font-size:17px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.dsk-code{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}\n.dsk-price{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}\n.dsk-chg{font-size:13px;font-variant-numeric:tabular-nums}\n.dsk-spacer{flex:1 1 auto}\n/* 指数快捷行：按市场分组（沪深 / 港股 / 美股）。\n   组与组之间留更大的间距，组内紧凑 —— 否则 11 个按钮连成一片看不出市场归属。 */\n.dsk-indexRow{display:flex;align-items:center;gap:14px;padding:0 clamp(12px,2vw,24px) 8px;flex-wrap:wrap;row-gap:6px}\n.dsk-indexGroup{display:flex;align-items:center;gap:6px;flex-wrap:wrap}\n.dsk-indexLabel{font-size:12px;color:var(--dsw-alias-label-secondary);flex:none}\n.dsk-tabs{display:flex;flex-wrap:wrap;gap:2px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:2px}\n.dsk-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:20px;padding:3px 9px;border-radius:6px;font-family:inherit}\n.dsk-tab:hover{color:var(--dsw-alias-label-primary)}\n.dsk-tab[data-on=\"1\"]{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.12)}\n.dsk-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:8px;padding:4px 10px;font-size:12px;font-family:inherit;line-height:20px;display:inline-flex;align-items:center;gap:5px}\n.dsk-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}\n.dsk-btn[data-on=\"1\"]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}\n/* 刷新按钮定宽：加载时文字前多一个转圈，不定宽会让整行左右抖动 */\n.dsk-btnRefresh{min-width:68px;justify-content:center}\n.dsk-search{position:relative}\n.dsk-input{box-sizing:border-box;width:190px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font-size:12px;line-height:20px;font-family:inherit;outline:none}\n.dsk-input:focus{border-color:var(--dsw-alias-brand-primary)}\n.dsk-menu{position:absolute;z-index:40;top:calc(100% + 4px);left:0;width:280px;max-height:300px;overflow:auto;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:3px;box-shadow:0 8px 24px rgba(0,0,0,.18)}\n.dsk-menuItem{display:flex;gap:8px;align-items:baseline;justify-content:space-between;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;padding:5px 8px;border-radius:7px;cursor:pointer;font-family:inherit;text-align:left}\n/* 鼠标悬停与键盘高亮共用同一个视觉状态 */\n.dsk-menuItem:hover,.dsk-menuItem[data-active=\"1\"]{background:var(--dsw-alias-bg-layer-2)}\n/* 「搜索中…」「没有匹配」「输入提示」：不是可选项，所以不吃鼠标、不显示手型 */\n.dsk-menuNote{display:flex;align-items:center;gap:6px;padding:7px 8px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:default}\n/* 「直接查询」兜底行：与真实候选分隔开，避免被误当成某只股票 */\n.dsk-menuDirect{color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);border-radius:0;margin-top:2px;padding-top:7px}\n.dsk-menuDirect:hover,.dsk-menuDirect[data-active=\"1\"]{color:var(--dsw-alias-label-primary)}\n.dsk-menuName{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.dsk-menuCode{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:11px;flex:none}\n.dsk-canvas{position:relative;flex:1 1 280px;min-height:280px;margin:0 clamp(12px,2vw,24px) 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base);overflow:hidden}\n.dsk-fill{position:absolute;inset:0}\n.dsk-svg{display:block;width:100%;height:100%;cursor:crosshair;touch-action:none;user-select:none}\n.dsk-size{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}\n.dsk-legend{position:absolute;left:10px;top:8px;display:flex;flex-wrap:wrap;gap:10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;pointer-events:none}\n.dsk-legend b{font-weight:500;color:var(--dsw-alias-label-primary)}\n.dsk-hint{position:absolute;left:0;right:0;bottom:0;padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-secondary);background:linear-gradient(transparent,var(--dsw-alias-bg-base));text-align:right;pointer-events:none}\n.dsk-state{flex:1 1 auto;display:flex;align-items:center;justify-content:center;padding:24px;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center;gap:10px;flex-direction:column}\n.dsk-stateErr{color:var(--dsw-alias-state-error-primary);max-width:520px;line-height:20px}\n.dsk-badge{font-size:10px;line-height:16px;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}\n.dsk-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dsk-rot .8s linear infinite}\n@keyframes dsk-rot{to{transform:rotate(360deg)}}\n.dsk-icon{display:block}\n.dsk-switch{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;padding:6px 0}\n.dsk-ticker{position:fixed;z-index:2147483000;pointer-events:auto;padding:0;border:0;background:transparent;font-family:\"Microsoft YaHei UI\",\"Segoe UI\",\"PingFang SC\",sans-serif;user-select:none}\nhtml body .dsk-ticker,html body .dsk-ticker *{box-sizing:border-box;text-shadow:none;opacity:1;visibility:visible;background:transparent;border:0;box-shadow:none}\nhtml body .dsk-tickerSvg{display:block;overflow:visible}\nhtml body .dsk-tickerSvg text{font-family:\"Microsoft YaHei UI\",\"Segoe UI\",\"PingFang SC\",\"Noto Sans CJK SC\",sans-serif}";

  /** 幂等注入；同版本已存在时直接覆盖内容，保证一定是最新的。 */
  function installCss() {
    if (typeof document === 'undefined') return undefined;
    var existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG) + ']');
    if (existing !== null && existing !== undefined) {
      existing.textContent = STYLE_TEXT;
      return undefined;
    }
    var tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-stock-kline';
    tag.dataset.pluginCss = STYLE_TAG;
    tag.textContent = STYLE_TEXT;
    (document.head === undefined || document.head === null ? document.body : document.head).appendChild(tag);
    return undefined;
  }

  /** 取当前样式文本（测试与调试用）。 */
  function getCss() {
    return STYLE_TEXT;
  }

  return { STYLE_TAG: STYLE_TAG, cssText: STYLE_TEXT, getCss: getCss, installCss: installCss };
    };

    // ===================== market =====================
    __factories["market"] = function () {
  var react = require('react');
  var h = require('react').createElement;
  var useState = require('react').useState;
  var useEffect = require('react').useEffect;
  var useRef = require('react').useRef;
  var useMemo = require('react').useMemo;
  var useCallback = require('react').useCallback;
  var useSyncExternalStore = require('react').useSyncExternalStore;
  var prefs = R("prefs");
  var API = prefs.API;
  var LOCAL_KEY = prefs.LOCAL_KEY;
  var PREF_KEYS = prefs.PREF_KEYS;
  var loadLocalPrefs = prefs.loadLocalPrefs;
  var saveLocalPrefs = prefs.saveLocalPrefs;
  var format = R("format");
  var fmtPrice = format.fmtPrice;
  var fmtLarge = format.fmtLarge;
  var fmtPct = format.fmtPct;
  var shortDate = format.shortDate;
  var dateLabel = format.dateLabel;
  var niceTicks = format.niceTicks;
  var movingAverage = format.movingAverage;
  var baselineOf = format.baselineOf;
  var lastClose = format.lastClose;
  var UP = format.UP;
  var DOWN = format.DOWN;
  var MA_COLORS = format.MA_COLORS;
  var INK = format.INK;
  var MUTED = format.MUTED;
  var HALO = format.HALO;
  var MIN_VISIBLE_BARS = format.MIN_VISIBLE_BARS;
  var MAX_VISIBLE_BARS = format.MAX_VISIBLE_BARS;
  var DEFAULT_VISIBLE_BARS = format.DEFAULT_VISIBLE_BARS;
  var ZOOM_STEP = format.ZOOM_STEP;
  var clampVisibleBars = format.clampVisibleBars;
  var zoomStepsToCount = format.zoomStepsToCount;
  /**
   * 行情状态中心（store）与订阅 Hook
   *
   * 主面板与价格挂件共用同一份行情与同一个选中股票。
   * 挂件挂在 shell.overlay、与主面板没有共同 React 祖先，Context 传不过去，
   * 所以用模块级订阅式 store —— 在这个 bundle 里它天然是同一份。
   * 依赖注入：prefs 模块的 loadLocalPrefs / saveLocalPrefs / PREF_KEYS / API。
   */

  /**
   * 各周期的**自动刷新间隔**（毫秒）。
   *
   * 为什么按周期分档而不是取一个固定值：周期的粒度本身就说明了"要多久看一次"。
   *   · 分时是一整天的逐笔走势，看的就是即时，5 秒必须有新数；
   *   · 5/15 分钟一根，间隔按"能在一根内看到几眼"来给；
   *   · 日/周/月 K 的**最后一根**收盘价全天都在变，所以仍然要刷，
   *     只是不需要那么勤 —— 统一压到 60 秒上限，保证价格不会看起来"冻住"。
   *
   * 上限 60 秒也是个产品判断：不管看哪个周期，屏幕上的价格最多 1 分钟就该动一次，
   * 否则用户会怀疑数据挂了（这正是加自动刷新之前的状态）。
   */
  var REFRESH_MS_BY_PERIOD = {
    minute: 5000, // 分时
    '5': 10000, // 5 分钟
    '15': 15000, // 15 分钟
    '30': 30000, // 30 分钟
    '60': 30000, // 60 分钟
    day: 60000, // 日 K
    week: 60000, // 周 K
    month: 60000, // 月 K
  };

  /** 未知周期时的兜底间隔（取上限，宁可慢也不要打得太密）。 */
  var DEFAULT_REFRESH_MS = 60000;

  /** 这个周期该多久刷一次。 */
  function refreshIntervalFor(period) {
    return REFRESH_MS_BY_PERIOD[period] === undefined ? DEFAULT_REFRESH_MS : REFRESH_MS_BY_PERIOD[period];
  }

  function createStore() {
    var state = {
      /**
       * 默认沪深300。指数只走东财/腾讯 ——
       * 同花顺的 `v6/line` 对指数一律 502/504/404，而且 `hs_000001` 会被它
       * 当成深市个股（返回「平安银行」）。
       */
      symbol: '000300',
      /**
       * 默认周期用日 K，**不用分时**：分时对指数两边都拿不到
       * （同花顺 `v6/time/hs_000300` 直接 404，东财 1 分钟线也不支持指数），
       * 用日 K 才能保证"打开就有图"。
       */
      period: 'day',
      /**
       * 缩放维度：主面板当前显示多少根 K 线。
       *
       * 放在 store 里（而不是 KlineChart 内部 state）是为了让**对话背景跟着主面板
       * 画同一段行情** —— 两处共用这一个值，主面板写、背景读。
       * 上下限与夹取在 format.js（`clampVisibleBars`），这里只做转发与持久化。
       */
      zoom: DEFAULT_VISIBLE_BARS,
      ma: [5, 10, 20],
      /** 右下角价格挂件是否显示（默认显示：很小，只放名称和涨跌幅） */
      tickerOpen: true,
      /** 对话页面背景 K 线是否开启（默认开启） */
      skinOpen: true,
      /**
       * 价格挂件的位置尺寸。
       * `undefined` = 还没拖过，贴右下角自动定位；
       * `{ dock: true }` = 用户双击归位；
       * `{ x, y, dock: false, ... }` = 用户拖到的自由坐标。
       */
      tickerBox: undefined,
      quote: null,
      loading: false,
      error: null,
      updatedAt: 0,
      source: null,
    };
    var listeners = new Set();
    var inFlight = null;
    var requestSeq = 0;
    /**
     * 用户是否已经动过偏好。
     *
     * 为什么必须有这个标记：`hydrate()` 会后到地拉一次宿主偏好，而它可能在用户
     * 刚点了「打开迷你图」「切到周K」之后才返回 —— 那一次覆盖会把用户的动作抹掉。
     * 标记一旦置位，宿主回填就不再覆盖本地（本地已经通过 persist 写回宿主了）。
     */
    var touched = false;

    function emit() {
      listeners.forEach(function (listener) {
        try {
          listener();
        } catch (error) {
          console.warn('[dsh-stock-kline] 订阅者异常', error);
        }
      });
    }

    function set(patch) {
      // 必须换一个新的 state 对象：useSyncExternalStore 靠**引用比较**判断快照是否变化，
      // 原地改属性会让 React 认为没变化而跳过重渲染。
      var changed = false;
      Object.keys(patch).forEach(function (key) {
        if (!Object.is(state[key], patch[key])) changed = true;
      });
      if (!changed) return;
      state = Object.assign({}, state, patch);
      emit();
    }

    function get() {
      return state;
    }

    function subscribe(listener) {
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    }

    function persist(patch) {
      touched = true;
      var next = {};
      PREF_KEYS.forEach(function (key) {
        var value = key in patch ? patch[key] : state[key];
        if (value !== undefined) next[key] = value;
      });
      // 本地存储是**主存储**：宿主那半边的偏好白名单是进程启动时加载的，
      // 插件升级后不重启 DSH 就不认识新字段（会被静默丢弃）。
      // 所以先落本地，宿主同步失败/被裁剪都不影响下一次打开。
      saveLocalPrefs(Object.assign(loadLocalPrefs(), next));
      fetch(API + '/prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      }).catch(function () {
        /* 宿主不可达时本地已存，不影响使用 */
      });
    }

    /** 拉一次行情；重复调用会复用同一个在途请求。 */
    function refresh() {
      if (inFlight !== null) return inFlight;
      var seq = ++requestSeq;
      var target = state.symbol;
      var period = state.period;
      set({ loading: true, error: null });
      var url =
        API + '/quote?symbol=' + encodeURIComponent(target) + '&period=' + encodeURIComponent(period);
      inFlight = fetch(url)
        .then(function (res) {
          return res.json().then(function (body) {
            if (!res.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + res.status);
            return body;
          });
        })
        .then(function (body) {
          if (seq !== requestSeq) return null;
          set({
            quote: body,
            loading: false,
            error: null,
            updatedAt: Date.now(),
            source: body.source,
          });
          return body;
        })
        .catch(function (error) {
          if (seq !== requestSeq) return null;
          set({ loading: false, error: error instanceof Error ? error.message : String(error) });
          return null;
        })
        .finally(function () {
          inFlight = null;
        });
      return inFlight;
    }

    function selectSymbol(symbol) {
      if (!symbol || symbol === state.symbol) {
        refresh();
        return;
      }
      set({ symbol: symbol, quote: null });
      persist({ symbol: symbol });
      refresh();
    }

    function setPeriod(period) {
      if (period === state.period) return;
      set({ period: period, quote: null });
      persist({ period: period });
      refresh();
      // 周期变了 → 刷新间隔也要跟着换档（分时 5s ↔ 月K 60s）
      startAutoRefresh();
    }

    /**
     * 自动刷新定时器。
     *
     * 挂在 store 上而不是面板组件里，是因为**浮窗与背景 K 线在对话页就能看到** ——
     * 如果只在面板挂载时才启动，用户一离开行情面板，那两处的数字就冻住了。
     */
    var autoTimer = null;

    /** 停掉自动刷新（幂等）。 */
    function stopAutoRefresh() {
      if (autoTimer === null) return;
      clearInterval(autoTimer);
      autoTimer = null;
    }

    /**
     * 启动自动刷新，间隔跟随当前周期；重复调用会先停掉旧的重排。
     * @returns {number} 本次采用的间隔（毫秒）
     */
    function startAutoRefresh() {
      stopAutoRefresh();
      var delay = refreshIntervalFor(state.period);
      autoTimer = setInterval(function () {
        // 页面在后台时不取数：用户看不见，白耗请求。
        // （浏览器本来也会节流后台定时器，但显式判断更好读，也便于测试。）
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        refresh();
      }, delay);
      return delay;
    }

    /** 右下角价格挂件开关。 */
    function setTickerOpen(open) {
      set({ tickerOpen: open });
      persist({ tickerOpen: open });
    }

    /** 对话页面背景 K 线开关。 */
    function setSkinOpen(open) {
      set({ skinOpen: open });
      persist({ skinOpen: open });
    }

    /**
     * 记住价格挂件的位置。
     *
     * 只传 `{ dock: true }` 表示"回到右下角"（双击归位用）；
     * 传坐标表示用户拖到了那里，之后不再自动贴角。
     */
    function rememberTickerBox(box) {
      var next;
      if (box === null || box === undefined || box.dock === true) {
        next = { dock: true };
      } else {
        next = {
          dock: false,
          x: Math.round(Number(box.x) || 0),
          y: Math.round(Number(box.y) || 0),
          w: Math.round(Number(box.w) || 0),
          h: Math.round(Number(box.h) || 0),
        };
      }
      set({ tickerBox: next });
      persist({ tickerBox: next });
    }

    /**
     * 记录缩放维度（主面板当前显示多少根）。
     *
     * 夹取放在这里而不是调用方：主面板、背景、以后任何入口写进来的值
     * 都必须落进同一个合法区间，否则两边会画出不一致的范围。
     * `total` 未知时传 0 —— `clampVisibleBars` 会退回下限。
     */
    function setZoom(count, total) {
      var next = clampVisibleBars(count, typeof total === 'number' ? total : 0);
      if (next === state.zoom) return;
      set({ zoom: next });
      persist({ zoom: next });
    }

    function hydrate() {
      var local = loadLocalPrefs();
      var patch = {};
      PREF_KEYS.forEach(function (key) {
        if (local[key] !== undefined) patch[key] = local[key];
      });
      if (Object.keys(patch).length > 0) set(patch);
      // 宿主侧偏好更权威（换浏览器/清缓存后仍是同一只股票），异步覆盖；
      // 但用户已经动过就不再覆盖，否则会把刚点的开关/刚切的周期抹掉。
      fetch(API + '/prefs')
        .then(function (res) {
          return res.json();
        })
        .then(function (body) {
          if (touched || !body || !body.prefs) return;
          var prefs = body.prefs;
          var hosted = {};
          PREF_KEYS.forEach(function (key) {
            if (prefs[key] !== undefined) hosted[key] = prefs[key];
          });
          saveLocalPrefs(Object.assign(loadLocalPrefs(), hosted));
          set(hosted);
          // 宿主偏好可能改了周期 → 刷新间隔跟着换档
          if (autoTimer !== null) startAutoRefresh();
        })
        .catch(function () {
          /* 宿主不可达就用本地值 */
        });
    }

    return {
      get: get,
      set: set,
      subscribe: subscribe,
      refresh: refresh,
      hydrate: hydrate,
      selectSymbol: selectSymbol,
      setPeriod: setPeriod,
      setTickerOpen: setTickerOpen,
      setSkinOpen: setSkinOpen,
      setZoom: setZoom,
      rememberTickerBox: rememberTickerBox,
      // 自动刷新
      startAutoRefresh: startAutoRefresh,
      stopAutoRefresh: stopAutoRefresh,
      refreshIntervalFor: refreshIntervalFor,
      REFRESH_MS_BY_PERIOD: REFRESH_MS_BY_PERIOD,
    };
  }

  function useStore(store) {
    var useStateExternal = react.useSyncExternalStore;
    if (typeof useStateExternal === 'function') {
      return useStateExternal(store.subscribe, store.get, store.get);
    }
    var pair = useState(store.get());
    useEffect(function () {
      return store.subscribe(function () {
        pair[1](store.get());
      });
    }, [store]);
    return pair[0];
  }

  return {
    createStore: createStore,
    useStore: useStore,
    // 自动刷新的间隔表与取值函数：plugin 要用（启动定时器），测试也要断言
    REFRESH_MS_BY_PERIOD: REFRESH_MS_BY_PERIOD,
    refreshIntervalFor: refreshIntervalFor,
  };
    };

    // ===================== chart =====================
    __factories["chart"] = function () {
  var react = require('react');
  var h = require('react').createElement;
  var useState = require('react').useState;
  var useEffect = require('react').useEffect;
  var useRef = require('react').useRef;
  var useMemo = require('react').useMemo;
  var useCallback = require('react').useCallback;
  var useSyncExternalStore = require('react').useSyncExternalStore;
  var format = R("format");
  var fmtPrice = format.fmtPrice;
  var fmtLarge = format.fmtLarge;
  var fmtPct = format.fmtPct;
  var shortDate = format.shortDate;
  var dateLabel = format.dateLabel;
  var niceTicks = format.niceTicks;
  var movingAverage = format.movingAverage;
  var baselineOf = format.baselineOf;
  var lastClose = format.lastClose;
  var UP = format.UP;
  var DOWN = format.DOWN;
  var MA_COLORS = format.MA_COLORS;
  var INK = format.INK;
  var MUTED = format.MUTED;
  var HALO = format.HALO;
  var MIN_VISIBLE_BARS = format.MIN_VISIBLE_BARS;
  var MAX_VISIBLE_BARS = format.MAX_VISIBLE_BARS;
  var DEFAULT_VISIBLE_BARS = format.DEFAULT_VISIBLE_BARS;
  var ZOOM_STEP = format.ZOOM_STEP;
  var clampVisibleBars = format.clampVisibleBars;
  var zoomStepsToCount = format.zoomStepsToCount;
  /**
   * K 线图（自绘 SVG）
   *
   * 滚轮缩放（改变可见根数）、悬停十字光标 + 当根数据行、
   * 成交量副图、均线、最新价虚线；分时周期走折线 + 均价线。
   * 依赖注入：React 能力 + format（格式化 / 常量 / 均线 / 昨收 / **缩放策略**）。
   *
   * ## 缩放是**受控**的
   *
   * 可见根数由外部（store）持有，通过 `props.zoom` 传入、`props.onZoom` 回传。
   * 这样对话背景才能跟着主面板画同一段行情 —— 缩放不再只是本组件的内部状态。
   * 不传 `zoom` 时退回内部 state，组件仍可独立使用（测试就是这么用的）。
   *
   * 上下限与夹取函数在 `format.js`（主面板与背景共用一份，避免两边漂移）。
   */

  /** 蜡烛实体宽度上下限（太窄看不清，太宽会盖住相邻的）。精简模式更窄。 */
  var MIN_BODY_W = 1;
  var MAX_BODY_W = 18;
  var MAX_BODY_W_COMPACT = 9;

  function KlineChart(props) {
    var quote = props.quote;
    var period = props.period;
    var maPeriods = props.ma || [];
    var height = props.height || 420;
    var compact = props.compact === true;

    var hostRef = useRef(null);
    // 初始尺寸给确定的数值：容器尺寸要等测量回填，若初始值是非数值
    // （例如 '100%'），首帧所有 y 坐标都会算成 NaN。measured=false 表示
    // 还没量到真实容器高度，此时按行内高度兜底绘制。
    var sizePair = useState({
      width: 720,
      height: typeof height === 'number' && height > 0 ? height : 420,
      measured: false,
    });
    var size = sizePair[0];
    var setSize = sizePair[1];

    /**
     * 缩放：受控优先。
     *
     * `props.zoom` 给了数值就用它（外部持有 —— 主面板把它存进 store，
     * 对话背景读同一个值，于是两边画同一段行情）；没给就退回内部 state。
     * `props.onZoom` 在每次缩放后回传新值。
     */
    var controlled = typeof props.zoom === 'number' && isFinite(props.zoom);
    var initialCount = controlled ? props.zoom : DEFAULT_VISIBLE_BARS;
    var viewPair = useState({ count: initialCount, offset: 0 });
    var view = viewPair[0];
    var setView = viewPair[1];
    var onZoomChange = typeof props.onZoom === 'function' ? props.onZoom : null;

    // 外部改了 zoom（例如另一处入口调整）→ 同步进来，并更新 ref
    useEffect(
      function () {
        if (!controlled) return;
        countRef.current = props.zoom;
        setView(function (prev) {
          return prev.count === props.zoom ? prev : { count: props.zoom, offset: prev.offset };
        });
      },
      [controlled, props.zoom],
    );

    var hoverPair = useState(null);
    var hover = hoverPair[0];
    var setHover = hoverPair[1];

    var dragRef = useRef(null);

    var candles = (quote && quote.candles) || [];
    var total = candles.length;

    // 尺寸跟随容器；量不到就依次退到父元素、窗口高度，最后才用行内默认值
    useEffect(
      function () {
        var node = hostRef.current;
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return undefined;
        var fallback = typeof height === 'number' && height > 0 ? height : Math.max(260, window.innerHeight - 240);

        var apply = function () {
          var rect = node.getBoundingClientRect();
          var width = Math.round(rect.width);
          var measured = Math.round(rect.height);
          if (!isFinite(width) || width <= 0) {
            var parent = node.parentElement;
            if (parent !== null && parent !== undefined && typeof parent.getBoundingClientRect === 'function') {
              width = Math.round(parent.getBoundingClientRect().width);
            }
          }
          if (!isFinite(width) || width <= 0) width = 720;
          if (!isFinite(measured) || measured <= 0) {
            // 容器高度塌成 0：再用父元素高度量一次
            var parentNode = node.parentElement;
            if (parentNode !== null && parentNode !== undefined && typeof parentNode.getBoundingClientRect === 'function') {
              measured = Math.round(parentNode.getBoundingClientRect().height);
            }
          }
          var healthy = isFinite(measured) && measured > 40;
          setSize({ width: Math.max(180, width), height: healthy ? Math.max(60, measured) : fallback, measured: healthy });
        };

        apply();
        // ResizeObserver 之外再挂一次窗口 resize：某些布局（面板切换、右栏开合）
        // 不一定会让被观察节点的内容盒变化，但一定伴随窗口或祖先的尺寸变化。
        window.addEventListener('resize', apply);
        var observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
        if (observer !== null) observer.observe(node);
        var timer = window.setTimeout(apply, 240);
        return function () {
          window.removeEventListener('resize', apply);
          if (observer !== null) observer.disconnect();
          window.clearTimeout(timer);
        };
      },
      [height],
    );

    /**
     * 换股票/周期时重置**视野**（主要是把平移位置拉回最新）。
     *
     * ⚠️ `useEffect` 在挂载时必然跑一次，所以这个 effect **不能无条件把可见根数
     * 写回默认值** —— 那会覆盖受控缩放。踩过的表现：
     *   "离开再回到行情面板，缩放丢失；滚一下轮子又恢复原本缩放"。
     * 原因是这里把 count 写成 120，而 `countRef` 里存的还是正确值，
     * 于是下一次滚轮以正确值为基准缩放，画面就"跳回"去了。
     *
     * 正确分工：
     *   · 受控时可见根数是**外部持有的"缩放维度"**（跨股票、跨会话保留），
     *     这里只重置 `offset`，count 交给 store；
     *   · 非受控（独立使用/迷你图）才自己按周期挑默认根数。
     */
    useEffect(
      function () {
        var nextCount;
        if (controlled) {
          nextCount = clampVisibleBars(props.zoom, total);
        } else {
          var fallback = compact
            ? Math.min(total || 80, 80)
            : period === 'minute'
              ? total || DEFAULT_VISIBLE_BARS
              : DEFAULT_VISIBLE_BARS;
          nextCount = clampVisibleBars(fallback, total);
        }
        countRef.current = nextCount;
        setView({ count: nextCount, offset: 0 });
      },
      [quote && quote.symbol, quote && quote.period, total === 0],
    );

    var metrics = useMemo(
      function () {
        var width = size.width;
        var chartHeight = size.height;
        var padTop = compact ? 6 : 8;
        var axisW = compact ? 40 : 52;
        var dateH = compact ? 14 : 18;
        var gap = 4;
        var volumeH = compact ? Math.round((chartHeight - padTop - dateH) * 0.22) : Math.round((chartHeight - padTop - dateH) * 0.24);
        var priceH = chartHeight - padTop - dateH - gap - volumeH;
        return {
          width: width,
          priceTop: padTop,
          priceH: Math.max(40, priceH),
          volumeTop: padTop + Math.max(40, priceH) + gap,
          volumeH: Math.max(24, volumeH),
          plotW: Math.max(40, width - axisW),
          axisW: axisW,
          dateH: dateH,
          chartHeight: chartHeight,
        };
      },
      [size.width, size.height, compact],
    );

    var slice = useMemo(
      function () {
        if (total === 0) return { rows: [], from: 0, ma: {}, visibleMa: [] };
        var count = clampVisibleBars(view.count, total);
        var maxOffset = Math.max(0, total - count);
        var offset = Math.max(0, Math.min(maxOffset, view.offset));
        var from = Math.max(0, total - count - offset);
        var rows = candles.slice(from, from + count);
        var ma = {};
        (maPeriods || []).forEach(function (size2) {
          ma[size2] = movingAverage(candles, size2).slice(from, from + count);
        });
        return { rows: rows, from: from, ma: ma, visibleMa: maPeriods || [] };
      },
      [candles, total, view.count, view.offset, JSON.stringify(maPeriods)],
    );

    var rows = slice.rows;
    var scale = useMemo(
      function () {
        if (rows.length === 0) return null;
        var min = Infinity;
        var max = -Infinity;
        var maxVolume = 0;
        rows.forEach(function (row) {
          if (row.low < min) min = row.low;
          if (row.high > max) max = row.high;
          if (row.volume > maxVolume) maxVolume = row.volume;
        });
        var maValues = [];
        (slice.visibleMa || []).forEach(function (size2) {
          (slice.ma[size2] || []).forEach(function (value) {
            if (value !== null && isFinite(value)) maValues.push(value);
          });
        });
        if (maValues.length > 0) {
          min = Math.min(min, Math.min.apply(null, maValues));
          max = Math.max(max, Math.max.apply(null, maValues));
        }
        if (!isFinite(min) || !isFinite(max)) return null;
        if (max === min) {
          max = max + Math.max(0.01, Math.abs(max) * 0.001);
          min = min - Math.max(0.01, Math.abs(min) * 0.001);
        }
        // 至少留 0.4% 的上下空白：日内振幅极小的周期（例如停牌/一字板）如果
        // 上下界贴在一起，所有蜡烛都会画成同一条横线，看起来就像"一条白纹"。
        var floor = Math.max((max - min) * 0.06, Math.abs(max) * 0.002, 0.01);
        min = min - floor;
        max = max + floor;
        if (!isFinite(min) || !isFinite(max) || max <= min) return null;
        return {
          min: min,
          max: max,
          maxVolume: maxVolume <= 0 ? 1 : maxVolume,
          preClose: baselineOf(quote),
        };
      },
      [rows, slice.ma, slice.visibleMa, quote],
    );

    var geometry = useMemo(
      function () {
        if (rows.length === 0 || scale === null) return null;
        var step = metrics.plotW / rows.length;
        var bodyW = Math.max(MIN_BODY_W, Math.min(compact ? MAX_BODY_W_COMPACT : MAX_BODY_W, step * 0.72));
        var yPrice = function (value) {
          // 兜底：任何异常输入都不该产出 NaN 坐标（NaN 会让整个 svg 属性失效）
          if (!isFinite(value) || !isFinite(scale.min) || !isFinite(scale.max) || scale.max === scale.min) {
            return metrics.priceTop;
          }
          var ratio = (value - scale.min) / (scale.max - scale.min);
          return metrics.priceTop + (1 - ratio) * metrics.priceH;
        };
        var yVolume = function (value) {
          if (!isFinite(value) || !isFinite(scale.maxVolume) || scale.maxVolume <= 0) {
            return metrics.volumeTop + metrics.volumeH;
          }
          var ratio = value / scale.maxVolume;
          return metrics.volumeTop + metrics.volumeH - Math.min(1, ratio) * metrics.volumeH;
        };
        var items = rows.map(function (row, index) {
          var center = index * step + step / 2;
          return {
            row: row,
            index: index,
            center: center,
            up: row.close >= row.open,
            bodyTop: yPrice(Math.max(row.open, row.close)),
            bodyBottom: yPrice(Math.min(row.open, row.close)),
            highY: yPrice(row.high),
            lowY: yPrice(row.low),
            volumeY: yVolume(row.volume),
            volumeH: metrics.volumeTop + metrics.volumeH - yVolume(row.volume),
            bodyW: bodyW,
          };
        });
        var maLines = (slice.visibleMa || []).map(function (size2, order) {
          var points = (slice.ma[size2] || [])
            .map(function (value, index) {
              if (value === null || !isFinite(value)) return null;
              return (index * step + step / 2).toFixed(1) + ',' + yPrice(value).toFixed(1);
            })
            .filter(Boolean)
            .join(' ');
          return { size: size2, points: points, color: MA_COLORS[order % MA_COLORS.length] };
        });
        return {
          step: step,
          yPrice: yPrice,
          yVolume: yVolume,
          items: items,
          maLines: maLines,
          ticks: niceTicks(scale.min, scale.max, compact ? 3 : 5),
        };
      },
      [rows, scale, metrics, slice.ma, slice.visibleMa, compact],
    );

    var last = rows.length > 0 ? rows[rows.length - 1] : null;
    var lastY = geometry !== null && last !== null ? geometry.yPrice(last.close) : null;
    var preCloseY =
      geometry !== null && scale !== null && scale.preClose !== null && isFinite(scale.preClose)
        ? geometry.yPrice(scale.preClose)
        : null;

    /**
     * 滚轮累积器：把一帧内的所有滚轮事件合并成**一次**状态更新。
     *
     * ## 为什么必须合并（"滑得太快就黑屏"的根因）
     *
     * 快速滚动时，滚轮事件的速率远高于帧率 —— 一帧里能来 5~10 个事件。
     * 如果每个事件都 `setView`，就是一帧内触发十次完整的 React 重渲染，
     * 而每次要重建 240 根蜡烛（含成交量就是近 500 个 SVG 节点）。
     * 主线程被这些渲染塞满，来不及把画面提交给合成器，浏览器就呈现不出内容 ——
     * 观感正是"滑太快直接黑屏"。慢速滚动每帧只有一个事件，所以不会出问题，
     * 这也解释了为什么问题只在"滑得快"时出现。
     *
     * ## 做法
     *
     * 事件里只累加"缩放意图"（次数 + 方向），然后用 `requestAnimationFrame`
     * 在一帧结束时统一应用一次。顺带的好处：缩放量正比于滚动次数，
     * 快滑一下就能跨过好几十根，比每个事件各乘一次 1.15 更符合手感。
     */
    var wheelRef = useRef({ steps: 0, frame: 0, pending: false });

    /**
     * 当前生效的可见根数。
     *
     * 用 ref 保存是因为 `applyWheel` 在 rAF 里执行，闭包里的 `view.count` / `props.zoom`
     * 可能是上一帧的值；读 ref 才能保证累加的基准是最新的。
     */
    var countRef = useRef(initialCount);

    var applyWheel = useCallback(
      function () {
        var acc = wheelRef.current;
        acc.frame = 0;
        acc.pending = false;
        var steps = acc.steps;
        acc.steps = 0;
        if (steps === 0 || total === 0) return;

        var current = countRef.current;
        var next = zoomStepsToCount(current, steps, total);
        if (next === current) {
          // 已经顶到边界：打一条诊断，用户报问题时这行能说明当时的可见根数与容器尺寸
          try {
            console.log(
              '[dsh-stock-kline] 缩放已到边界：可见 ' +
                next +
                ' 根 / 共 ' +
                total +
                ' 根；容器 ' +
                metrics.width +
                '×' +
                metrics.chartHeight +
                '；' +
                next * 2 +
                ' 个 K 线节点',
            );
          } catch (error) {
            /* 某些受限环境里 console 不可写，日志失败不该影响缩放 */
          }
          return;
        }

        countRef.current = next;
        // 可见根数变了 → 原来的悬停下标指向的已经不是同一根蜡烛，清掉。
        // （不清也不会崩 —— hoverItem 有越界保护 —— 但十字光标会指向错误的蜡烛。）
        setHover(null);
        setView(function (prev) {
          return { count: next, offset: prev.offset };
        });
        // 回传给外部（store）→ 对话背景据此画同一段行情
        if (onZoomChange !== null) onZoomChange(next);
      },
      [total, metrics.width, metrics.chartHeight, onZoomChange],
    );

    var onWheel = useCallback(
      function (event) {
        if (total === 0) return;
        // ⚠️ 这里的 preventDefault **不生效** —— React 把 onWheel 注册成 passive 监听器，
        // 浏览器会打印 "Unable to preventDefault inside passive event listener invocation."
        // 并忽略这次调用。所以拦默认行为交给下面那个原生非 passive 监听器（用 ref 挂）。
        // 这里只保留 stopPropagation：passive 只禁 preventDefault，不禁 stopPropagation。
        event.stopPropagation();

        var acc = wheelRef.current;
        // 只记方向、不记原始 deltaY：不同设备的 deltaY 量级差很多（鼠标 100、触控板个位数）
        acc.steps += event.deltaY > 0 ? 1 : -1;
        // ⚠️ 用独立的布尔量判断"本帧是否已排队"，**不能**拿 `frame !== 0` 当判据：
        // `requestAnimationFrame` 的返回值合法地可以是 0（本机测试台就是），
        // 那样守卫会失效，变成每个事件都排一次 —— 正好退回我们要修的行为。
        if (acc.pending) return;
        acc.pending = true;

        var host = typeof window === 'undefined' ? null : window;
        if (host !== null && typeof host.requestAnimationFrame === 'function') {
          acc.frame = host.requestAnimationFrame(applyWheel);
          return;
        }
        acc.frame = setTimeout(applyWheel, 16);
      },
      [total, applyWheel],
    );

    /**
     * 原生非 passive 的 wheel 监听：**唯一**能真正拦住页面滚动的地方。
     *
     * 为什么不能用 React 的 `onWheel` 做这件事：React 17+ 把它挂成 passive，
     * `preventDefault()` 会被忽略并打印警告（实测 console 里就是这行：
     * `Unable to preventDefault inside passive event listener invocation.`），
     * 结果滚轮既缩放图表、又把页面滚走 —— 观感就是"一片空白/黑屏"。
     *
     * 挂在图表容器上（svg 是它的子元素，事件会冒泡上来），只调 preventDefault；
     * **不 stopPropagation** —— 一旦在这里停掉事件，React 的 onWheel 就收不到，
     * 缩放逻辑不会执行。
     */
    useEffect(
      function () {
        var el = hostRef.current;
        if (el === null || el === undefined || typeof el.addEventListener !== 'function') return undefined;

        var onNativeWheel = function (event) {
          // 只有真的会缩放时才拦；没有数据时让页面正常滚
          if (total === 0) return;
          event.preventDefault();
        };
        el.addEventListener('wheel', onNativeWheel, { passive: false });
        return function () {
          el.removeEventListener('wheel', onNativeWheel, { passive: false });
        };
      },
      [total],
    );

    // 卸载时把排队的这一帧取消掉，避免在已卸载的组件上 setState
    useEffect(
      function () {
        return function () {
          var acc = wheelRef.current;
          if (!acc.pending) return;
          var host = typeof window === 'undefined' ? null : window;
          if (host !== null && typeof host.cancelAnimationFrame === 'function') host.cancelAnimationFrame(acc.frame);
          else clearTimeout(acc.frame);
          acc.pending = false;
          acc.frame = 0;
          acc.steps = 0;
        };
      },
      [],
    );

    var onPointerDown = useCallback(
      function (event) {
        dragRef.current = { x: event.clientX, offset: view.offset };
        // ⚠️ 必须在**挂这些处理器的那个元素**（svg）上捕获，不能捕获到父容器。
        //
        // 指针捕获会把后续 pointermove **重定向到捕获元素**，事件路径随之变成
        // `捕获元素 → … → root`。svg 是 .dsk-canvas 的**后代**，一旦捕获设在容器上，
        // svg 就不在事件路径里了 —— 它的 onPointerMove / onPointerUp 全都收不到：
        //   · 拖动完全失效（这正是"按住拖动平移没有效果"的根因）；
        //   · 收不到 pointerup → dragRef 残留 → 之后**普通悬停都会误触发平移**。
        //
        // 用 event.currentTarget（= 当前处理器所在元素）而不是 hostRef.current，
        // 才能保证"捕获元素 === 处理器元素"。
        var target = event.currentTarget === undefined || event.currentTarget === null ? hostRef.current : event.currentTarget;
        if (target !== null && target !== undefined && typeof target.setPointerCapture === 'function') {
          try {
            target.setPointerCapture(event.pointerId);
          } catch (error) {
            // pointerId 非法（合成事件）或指针已消失：捕获失败不该中断拖动，
            // 指针仍在图内时拖动照常工作，只是移出图外会失去跟随。
          }
        }
      },
      [view.offset],
    );

    var onPointerMove = useCallback(
      function (event) {
        var node = hostRef.current;
        if (node === null) return;
        var rect = node.getBoundingClientRect();
        var localX = event.clientX - rect.left;
        var count = clampVisibleBars(view.count, total);
        var index = Math.floor((localX / Math.max(1, metrics.plotW)) * count);
        if (index >= 0 && index < rows.length) setHover(index);
        else setHover(null);

        var drag = dragRef.current;
        if (drag === null) return;
        var step = metrics.plotW / Math.max(1, count);
        var moved = Math.round((event.clientX - drag.x) / Math.max(1, step));
        var maxOffset = Math.max(0, total - count);
        var offset = Math.max(0, Math.min(maxOffset, drag.offset + moved));
        if (offset !== view.offset) setView({ count: count, offset: offset });
      },
      [total, view.count, view.offset, rows.length, metrics.plotW],
    );

    var onPointerUp = useCallback(function () {
      dragRef.current = null;
    }, []);

    /**
     * 悬停项：越界时归一化成 `null`（而不是 `undefined`）。
     *
     * ⚠️ 这里必须做**长度校验**，不能只判 `!== null`：
     * `geometry.items[hover]` 在 hover 越界时返回 `undefined`，而 `undefined !== null`
     * 是 true —— 后续 `hoverItem.row` 就会抛 TypeError。
     *
     * 这个越界是真实会发生的：鼠标停在某根上时滚轮放大，可见根数骤减，
     * 而 `hover` 还停在旧下标上（例如悬停第 150 根、放大到只剩 20 根）。
     * 崩溃会被 shell 的错误边界兜住，表现就是**整个面板变黑/空白**。
     *
     * 归一化成 null 之后，下游所有判断都可以安全地只写 `!== null`。
     */
    var hoverItem = null;
    if (hover !== null && geometry !== null && hover >= 0 && hover < geometry.items.length) {
      hoverItem = geometry.items[hover];
      if (hoverItem === undefined || hoverItem === null) hoverItem = null;
    }
    var legendRow = hoverItem !== null ? hoverItem.row : last;
    // 容器塌成 0 时 svg 什么也画不出来；给一句可诊断的说明而不是留白
    var tooSmall = size.measured === false;

    var header = [];
    if (legendRow !== null) {
      header.push(h('span', { key: 'd' }, dateLabel(legendRow.date)));
      header.push(h('span', { key: 'o' }, '开 ', h('b', {}, fmtPrice(legendRow.open))));
      header.push(h('span', { key: 'h' }, '高 ', h('b', {}, fmtPrice(legendRow.high))));
      header.push(h('span', { key: 'l' }, '低 ', h('b', {}, fmtPrice(legendRow.low))));
      header.push(h('span', { key: 'c' }, '收 ', h('b', {}, fmtPrice(legendRow.close))));
      if (!compact) header.push(h('span', { key: 'v' }, '量 ', h('b', {}, fmtLarge(legendRow.volume))));
      (slice.visibleMa || []).forEach(function (size2, order) {
        var values = slice.ma[size2] || [];
        var value = hoverItem !== null ? values[hoverItem.index] : values[values.length - 1];
        header.push(
          h(
            'span',
            { key: 'ma' + size2, style: { color: MA_COLORS[order % MA_COLORS.length] } },
            'MA' + size2 + ' ',
            h('b', { style: { color: 'inherit' } }, value === null || value === undefined ? '--' : fmtPrice(value)),
          ),
        );
      });
    }

    var children = [];
    if (geometry !== null && scale !== null) {
      // 价格网格与右侧刻度
      geometry.ticks.forEach(function (tick) {
        var y = geometry.yPrice(tick);
        if (y < metrics.priceTop - 2 || y > metrics.priceTop + metrics.priceH + 2) return;
        children.push(
          h('line', {
            key: 'grid' + tick,
            x1: 0,
            x2: metrics.plotW,
            y1: y,
            y2: y,
            stroke: 'currentColor',
            strokeOpacity: 0.1,
            strokeWidth: 1,
          }),
        );
        children.push(
          h(
            'text',
            {
              key: 'tick' + tick,
              x: metrics.plotW + 4,
              y: y + 3.5,
              fontSize: compact ? 9 : 10,
              fill: 'currentColor',
              opacity: 0.55,
            },
            fmtPrice(tick, tick >= 1000 ? 1 : 2),
          ),
        );
      });

      // 昨收虚线（涨跌分界）
      if (preCloseY !== null) {
        children.push(
          h('line', {
            key: 'pre',
            x1: 0,
            x2: metrics.plotW,
            y1: preCloseY,
            y2: preCloseY,
            stroke: 'currentColor',
            strokeOpacity: 0.35,
            strokeDasharray: '3 3',
            strokeWidth: 1,
          }),
        );
      }

      if (period === 'minute' && (quote.minutes || []).length > 0) {
        // 分时：价格折线 + 均价线 + 填充
        var minutes = quote.minutes;
        var visible = minutes.slice(slice.from, slice.from + rows.length);
        var linePoints = visible
          .map(function (point, index) {
            return (index * geometry.step + geometry.step / 2).toFixed(1) + ',' + geometry.yPrice(point.price).toFixed(1);
          })
          .join(' ');
        var avgPoints = visible
          .map(function (point, index) {
            return (
              (index * geometry.step + geometry.step / 2).toFixed(1) + ',' + geometry.yPrice(point.average).toFixed(1)
            );
          })
          .join(' ');
        if (linePoints !== '') {
          children.push(
            h('polyline', {
              key: 'mline',
              points: linePoints,
              fill: 'none',
              stroke: last !== null && scale.preClose !== null && last.close >= scale.preClose ? UP : DOWN,
              strokeWidth: 1.4,
            }),
          );
          children.push(
            h('polyline', {
              key: 'mavg',
              points: avgPoints,
              fill: 'none',
              stroke: '#d29922',
              strokeWidth: 1.1,
              strokeOpacity: 0.9,
            }),
          );
        }
      } else {
        geometry.items.forEach(function (item) {
          var color = item.up ? UP : DOWN;
          children.push(
            h('line', {
              key: 'w' + item.index,
              x1: item.center,
              x2: item.center,
              y1: item.highY,
              y2: item.lowY,
              stroke: color,
              strokeWidth: 1,
            }),
          );
          var bodyH = Math.max(1, item.bodyBottom - item.bodyTop);
          children.push(
            h('rect', {
              key: 'b' + item.index,
              x: item.center - item.bodyW / 2,
              y: item.bodyTop,
              width: item.bodyW,
              height: bodyH,
              fill: color,
            }),
          );
        });
      }

      // 成交量
      geometry.items.forEach(function (item) {
        var color = item.up ? UP : DOWN;
        children.push(
          h('rect', {
            key: 'v' + item.index,
            x: item.center - item.bodyW / 2,
            y: item.volumeY,
            width: item.bodyW,
            height: Math.max(0.5, item.volumeH),
            fill: color,
            fillOpacity: 0.55,
          }),
        );
      });

      // 均线
      geometry.maLines.forEach(function (line) {
        if (line.points === '') return;
        children.push(
          h('polyline', {
            key: 'ma' + line.size,
            points: line.points,
            fill: 'none',
            stroke: line.color,
            strokeWidth: compact ? 1 : 1.2,
            strokeOpacity: 0.95,
          }),
        );
      });

      // 最新价虚线 + 标签
      if (lastY !== null && last !== null) {
        var up = scale.preClose === null || last.close >= scale.preClose;
        children.push(
          h('line', {
            key: 'lastline',
            x1: 0,
            x2: metrics.plotW,
            y1: lastY,
            y2: lastY,
            stroke: up ? UP : DOWN,
            strokeWidth: 1,
            strokeDasharray: '4 3',
            strokeOpacity: 0.85,
          }),
        );
        var labelW = metrics.axisW - 4;
        children.push(
          h('rect', {
            key: 'lastbg',
            x: metrics.plotW + 2,
            y: lastY - 7,
            width: labelW,
            height: 14,
            rx: 3,
            fill: up ? UP : DOWN,
          }),
        );
        children.push(
          h(
            'text',
            {
              key: 'lasttext',
              x: metrics.plotW + 2 + labelW / 2,
              y: lastY + 3.5,
              fontSize: 10,
              fill: '#fff',
              textAnchor: 'middle',
            },
            fmtPrice(last.close),
          ),
        );
      }

      // 日期刻度（首/中/尾）
      var marks = [0, Math.floor(rows.length / 2), rows.length - 1].filter(function (value, index, arr) {
        return value >= 0 && arr.indexOf(value) === index;
      });
      marks.forEach(function (index) {
        if (rows[index] === undefined) return;
        var x = index * geometry.step + geometry.step / 2;
        children.push(
          h(
            'text',
            {
              key: 'date' + index,
              x: Math.min(metrics.plotW - 2, Math.max(14, x)),
              y: metrics.chartHeight - 4,
              fontSize: compact ? 8 : 10,
              fill: 'currentColor',
              opacity: 0.55,
              textAnchor: index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle',
            },
            shortDate(rows[index].date),
          ),
        );
      });

      // 十字光标
      if (hoverItem !== null) {
        children.push(
          h('line', {
            key: 'cx',
            x1: hoverItem.center,
            x2: hoverItem.center,
            y1: metrics.priceTop,
            y2: metrics.volumeTop + metrics.volumeH,
            stroke: 'currentColor',
            strokeOpacity: 0.45,
            strokeDasharray: '3 3',
            strokeWidth: 1,
          }),
        );
        children.push(
          h('line', {
            key: 'cy',
            x1: 0,
            x2: metrics.plotW,
            y1: hoverItem.lowY,
            y2: hoverItem.lowY,
            stroke: 'currentColor',
            strokeOpacity: 0.35,
            strokeDasharray: '3 3',
            strokeWidth: 1,
          }),
        );
      }
    }

    return h(
      'div',
      {
        className: compact ? 'dsk-canvas dsk-miniCanvas' : 'dsk-canvas',
        ref: hostRef,
        // 只在调用方给了确定像素高度时才设行内高度；传 '100%' 时交给
        // .dsk-canvas 自己的 flex:1 + .dsk-fill 的绝对定位去撑满。
        style: typeof height === 'number' ? { height: height + 'px' } : undefined,
      },
      [
        h(
          'svg',
          {
            key: 'svg',
            className: 'dsk-svg dsk-fill',
            viewBox: '0 0 ' + metrics.width + ' ' + metrics.chartHeight,
            preserveAspectRatio: 'none',
            onWheel: onWheel,
            onPointerDown: onPointerDown,
            onPointerMove: onPointerMove,
            onPointerUp: onPointerUp,
            onPointerCancel: onPointerUp,
            onPointerLeave: function () {
              onPointerUp();
              setHover(null);
            },
          },
          children,
        ),
        header.length > 0 ? h('div', { key: 'legend', className: 'dsk-legend' }, header) : null,
        compact
          ? null
          : // 只写**确实可用**的操作。曾经这里还写着「按住拖动平移」，
            // 而那个功能因为指针捕获挂错元素一直是失效的（见 onPointerDown 的注释）——
            // 说明文字不能承诺一个做不到的操作。
            h('div', { key: 'hint', className: 'dsk-hint' }, '滚轮缩放 · 悬停看当根数据'),
        tooSmall
          ? h(
              'div',
              { key: 'small', className: 'dsk-size' },
              '图表区域测到的高度为 0，无法绘制。请把窗口拉大一些，或切换一次面板重新测量。',
            )
          : null,
      ],
    );
  }

  return {
    KlineChart: KlineChart,
    // 缩放策略的纯函数不在这里导出 —— 它们住在 format.js（主面板与对话背景共用一份），
    // 由 scripts/build.mjs 的依赖表注入。测试接缝见 plugin.js 的 __test。
  };
    };

    // ===================== ticker =====================
    __factories["ticker"] = function () {
  var react = require('react');
  var h = require('react').createElement;
  var useState = require('react').useState;
  var useEffect = require('react').useEffect;
  var useRef = require('react').useRef;
  var useMemo = require('react').useMemo;
  var useCallback = require('react').useCallback;
  var useSyncExternalStore = require('react').useSyncExternalStore;
  var format = R("format");
  var fmtPrice = format.fmtPrice;
  var fmtLarge = format.fmtLarge;
  var fmtPct = format.fmtPct;
  var shortDate = format.shortDate;
  var dateLabel = format.dateLabel;
  var niceTicks = format.niceTicks;
  var movingAverage = format.movingAverage;
  var baselineOf = format.baselineOf;
  var lastClose = format.lastClose;
  var UP = format.UP;
  var DOWN = format.DOWN;
  var MA_COLORS = format.MA_COLORS;
  var INK = format.INK;
  var MUTED = format.MUTED;
  var HALO = format.HALO;
  var MIN_VISIBLE_BARS = format.MIN_VISIBLE_BARS;
  var MAX_VISIBLE_BARS = format.MAX_VISIBLE_BARS;
  var DEFAULT_VISIBLE_BARS = format.DEFAULT_VISIBLE_BARS;
  var ZOOM_STEP = format.ZOOM_STEP;
  var clampVisibleBars = format.clampVisibleBars;
  var zoomStepsToCount = format.zoomStepsToCount;
  var market = R("market");
  var createStore = market.createStore;
  var useStore = market.useStore;
  var REFRESH_MS_BY_PERIOD = market.REFRESH_MS_BY_PERIOD;
  var refreshIntervalFor = market.refreshIntervalFor;
  /**
   * 价格挂件（可拖动的浮层小窗）
   *
   * 只显示名称、代码、当前价、涨跌额与涨跌幅 —— 刻意不画 K 线。
   * 
   * 为什么内容用 SVG <text> 画：HTML 文本在浮层里可能完全不显示（容器背景与 tooltip
   * 都正常，就是看不到字），最可能是壳层的 -webkit-text-fill-color 被继承成透明 ——
   * 它连 color: … !important 都盖不住。SVG 的 fill 是呈现属性，不受这些规则影响。
   * 尺寸与配色同样全部内联，不依赖任何样式表是否命中。
   * 
   * 拖动方式与桌宠一致：pointerdown 记账 + window 上监听 move/up；双击回到右下角。
   */

  /**
   * 价格挂件（可拖动的浮层小标签）
   *
   * ## 信息量：只有「名称 + 涨跌百分比」
   *
   * 刻意做成最简：没有代码、没有现价、没有涨跌额、没有 K 线、**没有背景**。
   * 它就是贴在桌面角上的一个两段文字标签，不挡视线；需要细节就点开主面板。
   *
   * ## 为什么内容用 SVG <text> 画
   *
   * 这个浮层挂在 `shell.overlay` 上，而 overlay 的约定里有两条会咬人：
   *
   *   1. `.overlayLayer > * { pointer-events: auto }` —— 浮层子元素默认接管鼠标；
   *   2. 壳层会给浮层内容上色，`-webkit-text-fill-color` 一旦被继承成透明，
   *      `color: … !important` 也盖不住（实测过）。
   *
   * 所以走"零信任"策略：**每个可见元素都自带完整样式**，既不继承颜色、
   * 也不依赖任何外部样式表命中 —— 颜色走 `fill` 呈现属性 + `style.fill` 双保险，
   * 外加 SVG 内部一段按自有类名写死的 `<style>`。
   *
   * 图标（关闭）用 `<path>` 画，避免依赖字体里有没有 × 字形。
   *
   * ## 交互
   *
   * 拖动方式与桌宠一致：pointerdown 记账 + window 上监听 move/up；双击回到右下角。
   * 因为背景透明，关闭按钮只在鼠标悬停在标签上时才显形（见 hovered 状态）。
   */

  /** SVG 内部样式：按自有类名把可读性相关的属性全部钉死。 */
  var SVG_STYLE =
    '.dskSvgText{font-family:"Microsoft YaHei UI","Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif;' +
    'paint-order:stroke fill;stroke-width:2.6px;stroke-linejoin:round}' +
    '.dskSvgName{fill:#111418;-webkit-text-fill-color:#111418;font-size:13.5px;font-weight:700;stroke:rgba(255,255,255,.9)}' +
    '.dskSvgPct{font-size:14px;font-weight:800}' +
    // 关闭按钮的透明度由**内联样式**按 hover 控制，这里只钉路径的描边；
    // 不写 .dskSvgClose{opacity:…}，否则会和内联值打架（样式表优先级更高）。
    '.dskSvgClose path{stroke-width:1.5px;paint-order:normal}';

  /**
   * 标签内的排版常量（SVG 用户坐标，1:1 对应像素）。
   *
   * 关闭按钮那三个值要一起看：
   *   CLOSE_LEFT / CLOSE_RIGHT 是**命中矩形**的左右边（占满整个高度），
   *   比一个 r=10 的小圆好点得多；CLOSE_CX 只是那个 × 的绘制中心。
   */
  var NAME_X = 2;
  var PCT_RIGHT = 132;
  var CLOSE_LEFT = 136;
  var CLOSE_RIGHT = 160;
  var CLOSE_CX = 148;
  var TEXT_Y = 17;
  var SVG_H = 23;
  var CLOSE_ROW_Y = TEXT_Y - 4;

  function TickerSvg(props) {
    var quote = props.quote;
    var pct = props.pct;
    var color = props.color;
    var hovered = props.hovered === true;
    var cjk = '"Microsoft YaHei UI","PingFang SC","Noto Sans CJK SC",sans-serif';

    // 只显示百分比；fmtPct 自带正号（+.35% / -1.20%），不要再加一遍
    var pctText = pct === null || pct === undefined ? '--' : fmtPct(pct);

    /**
     * 一段文字：呈现属性 + style 双写，任何一边生效都能看见。
     *
     * `stroke` 是同色系的白描边 —— 背景透明，浮窗又压在 K 线皮肤上，
     * 描边能在不引入底色的前提下把笔画加粗，是"透明但要清楚"的唯一解。
     */
    var textNode = function (key, cls, x, y, size, weight, fill, anchor, content) {
      var style = {
        fontFamily: cjk,
        fontSize: size + 'px',
        fontWeight: String(weight),
        fill: fill,
        WebkitTextFillColor: fill,
        stroke: HALO,
        strokeWidth: '2.6px',
        paintOrder: 'stroke fill',
        strokeLinejoin: 'round',
      };
      if (anchor !== undefined) style.textAnchor = anchor;
      return h(
        'text',
        {
          key: key,
          className: 'dskSvgText ' + cls,
          x: x,
          y: y,
          fill: fill,
          fontSize: size,
          fontWeight: weight,
          fontFamily: cjk,
          textAnchor: anchor,
          stroke: HALO,
          strokeWidth: 2.6,
          paintOrder: 'stroke fill',
          strokeLinejoin: 'round',
          style: style,
        },
        content,
      );
    };

    var children = [
      h('style', { key: 'style' }, SVG_STYLE),
      // 股票名（左）
      textNode('name', 'dskSvgName', NAME_X, TEXT_Y, 13.5, 700, INK, undefined, quote ? quote.name : '加载中'),
      // 涨跌百分比（右对齐）—— 红涨绿跌
      textNode('pct', 'dskSvgPct', PCT_RIGHT, TEXT_Y, 14, 800, color, 'end', pctText),
    ];

    /**
     * 关闭按钮：**永远在 DOM 里、永远可点**。
     *
     * 之前只画在 `hovered` 为真时 —— 那是"点不到"的根因：
     * 鼠标往角落移动的过程中任何一次 `pointerleave` 都会把它从 DOM 摘掉，
     * 于是"正要点它就没了"。现在改成常驻，用**透明度**表达"悬停才明显"，
     * 命中区也从 `r=10` 的圆换成占满整高的大矩形（24×23）。
     *
     * 同时要挡住拖动：`pointerdown` 冒泡到容器会触发 `startDrag`，
     * 松手后 `movedRef` 变化还可能被当成"拖过了"而吞掉这一次点击。
     */
    children.push(
      h(
        'g',
        {
          key: 'close',
          className: 'dskSvgClose',
          // 半透明只是"平时不抢眼"，命中测试不受透明度影响：
          // 真正让"可见"与"可点"解耦的是**它常驻 DOM**，而不是靠 opacity 隐藏。
          style: { cursor: 'pointer', pointerEvents: 'auto', opacity: hovered ? 1 : 0.45 },
          onPointerDown: function (event) {
            event.stopPropagation();
          },
          onClick: function (event) {
            event.stopPropagation();
            if (props.onClose) props.onClose();
          },
        },
        [
          h('rect', {
            key: 'hit',
            x: CLOSE_LEFT,
            y: 0,
            width: CLOSE_RIGHT - CLOSE_LEFT,
            height: SVG_H,
            fill: 'transparent',
          }),
          h('path', {
            key: 'icon',
            d:
              'M' + (CLOSE_CX - 3.5) + ' ' + (CLOSE_ROW_Y - 3.5) + 'l7 7M' + (CLOSE_CX + 3.5) + ' ' + (CLOSE_ROW_Y - 3.5) + 'l-7 7',
            stroke: MUTED,
            strokeWidth: 1.5,
            fill: 'none',
            strokeLinecap: 'round',
            pointerEvents: 'none',
          }),
        ],
      ),
    );

    var svgW = CLOSE_RIGHT;

    return h(
      'svg',
      {
        className: 'dsk-tickerSvg',
        width: svgW,
        height: SVG_H,
        viewBox: '0 0 ' + svgW + ' ' + SVG_H,
        // 尺寸四面钉死：属性会被任何 CSS 覆盖，style 优先级更高；
        // 一旦被压成 0 或拉变形，viewBox 里的文字就会被裁掉。
        style: {
          display: 'block',
          width: svgW + 'px',
          height: SVG_H + 'px',
          minWidth: svgW + 'px',
          minHeight: SVG_H + 'px',
          maxWidth: svgW + 'px',
          maxHeight: SVG_H + 'px',
          flex: '0 0 auto',
          pointerEvents: 'auto',
          overflow: 'visible',
          opacity: 1,
          visibility: 'visible',
        },
        'aria-hidden': 'true',
      },
      children,
    );
  }

  function PriceTicker(props) {
    var store = props.store;
    var state = useStore(store);

    /** 打开行情主面板（主面板可用时）；不可用就忽略，不影响挂件本身。 */
    var openPanel = function () {
      if (typeof props.openMain === 'function') props.openMain();
    };

    // 位置：默认贴右下角（dock=true）；拖过一次之后就是自由坐标（dock=false）。
    // 与桌宠一样按窗口像素定位，并被夹在视口内。
    var saved = state.tickerBox;
    var dock = saved === undefined || saved === null || saved.dock !== false;
    var posPair = useState(null);
    var pos = posPair[0];
    var setPos = posPair[1];
    var boxRef = useRef(null);
    var dragRef = useRef(null);
    var movedRef = useRef(false);
    /**
     * 最新坐标的**同步**副本。
     *
     * 为什么不能只读 `pos`：`setPos` 之后同一次 tick 内 `pos` 还是旧值，
     * 而 pointerup 要把"松手时的位置"写进偏好 —— 读 state 会记成上一帧的坐标。
     */
    var posRef = useRef(null);

    /** 鼠标是否停在标签上：决定关闭按钮显不显形（背景透明，所以平时藏起来）。 */
    var hoverPair = useState(false);
    var hovered = hoverPair[0];
    var setHovered = hoverPair[1];

    /** 写坐标：ref 与 state 一起写，保证松手时读到的是最新值。 */
    var applyPos = function (next) {
      posRef.current = next;
      setPos(next);
    };

    // 首次/贴角模式：算出右下角坐标（用挂件真实尺寸，避免硬编码宽度）
    useEffect(
      function () {
        if (!dock) return undefined;
        var box = boxRef.current;
        if (box === null || box === undefined || typeof box.getBoundingClientRect !== 'function') return undefined;
        var measure = function () {
          var rect = box.getBoundingClientRect();
          var width = Math.round(rect.width);
          var height = Math.round(rect.height);
          if (!isFinite(width) || width <= 0) width = 210;
          if (!isFinite(height) || height <= 0) height = 30;
          applyPos({ x: Math.max(8, window.innerWidth - width - 16), y: Math.max(8, window.innerHeight - height - 16) });
        };
        measure();
        window.addEventListener('resize', measure);
        return function () {
          window.removeEventListener('resize', measure);
        };
      },
      [dock, state.tickerOpen],
    );

    /**
     * 一次性自检：把挂件与关键子元素的**实际计算样式**打到 console。
     *
     * 为什么需要它：内容明明画出来了却"看不见"，剩下的可能只有
     * "被上层样式压成透明 / 零尺寸"这一种，而在外面看不到页面 DOM 就没法判断。
     * 只打一次，不带轮询，不影响性能；看一眼 console 就能定位。
     */
    useEffect(
      function () {
        if (state.tickerOpen !== true) return undefined;
        if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
        var timer = window.setTimeout(function () {
          try {
            var box = document.querySelector('.dsk-ticker');
            var svg = box === null ? null : box.querySelector('svg');
            var text = svg === null ? null : svg.querySelector('text');
            var dump = function (node, label) {
              if (node === null || node === undefined) return label + '=null';
              var cs = window.getComputedStyle(node);
              var rect = node.getBoundingClientRect();
              return (
                label +
                ' ' +
                Math.round(rect.width) +
                '×' +
                Math.round(rect.height) +
                ' @' +
                Math.round(rect.left) +
                ',' +
                Math.round(rect.top) +
                ' | display=' +
                cs.display +
                ' visibility=' +
                cs.visibility +
                ' opacity=' +
                cs.opacity +
                ' color=' +
                cs.color +
                ' fill=' +
                cs.fill +
                ' textFill=' +
                cs.webkitTextFillColor +
                ' fontSize=' +
                cs.fontSize
              );
            };
            console.log('[dsh-stock-kline] 浮窗自检');
            console.log('  ' + dump(box, '容器'));
            console.log('  ' + dump(svg, 'svg'));
            console.log('  ' + dump(text, '首段文字'));
            if (text !== null && text !== undefined) {
              console.log('  文字内容=' + JSON.stringify(text.textContent));
            }
          } catch (error) {
            console.log('[dsh-stock-kline] 浮窗自检失败：' + (error instanceof Error ? error.message : String(error)));
          }
        }, 600);
        return function () {
          window.clearTimeout(timer);
        };
      },
      [state.tickerOpen],
    );

    // 自由位置模式：直接用记忆坐标，同样夹在视口内
    useEffect(
      function () {
        if (dock) return undefined;
        applyPos({
          x: Math.max(0, Math.min(window.innerWidth - 60, saved.x)),
          y: Math.max(0, Math.min(window.innerHeight - 24, saved.y)),
        });
        return undefined;
      },
      [dock, saved === undefined ? null : saved.x, saved === undefined ? null : saved.y],
    );

    // 拖动 / 松开：与桌宠同一套做法（pointerdown 记账 + window 上监听 move/up）
    var startDrag = function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      var current = pos === null ? { x: 16, y: window.innerHeight - 46 } : pos;
      movedRef.current = false;
      dragRef.current = { x: event.clientX, y: event.clientY, px: current.x, py: current.y };
      if (boxRef.current !== null && boxRef.current !== undefined && boxRef.current.setPointerCapture) {
        try {
          boxRef.current.setPointerCapture(event.pointerId);
        } catch (error) {
          /* 某些环境不支持 pointer capture：window 监听已经够了 */
        }
      }
    };

    useEffect(
      function () {
        var move = function (event) {
          var drag = dragRef.current;
          if (drag === null) return;
          var dx = event.clientX - drag.x;
          var dy = event.clientY - drag.y;
          if (!movedRef.current && Math.abs(dx) + Math.abs(dy) < 3) return;
          movedRef.current = true;
          applyPos({
            x: Math.max(0, Math.min(window.innerWidth - 60, drag.px + dx)),
            y: Math.max(0, Math.min(window.innerHeight - 24, drag.py + dy)),
          });
        };
        var up = function () {
          var drag = dragRef.current;
          if (drag === null) return;
          dragRef.current = null;
          if (!movedRef.current) return; // 没真的拖：当作点击，交给 onClick 处理
          var box = boxRef.current;
          var rect = box !== null && box !== undefined && box.getBoundingClientRect ? box.getBoundingClientRect() : null;
          var width = rect === null ? 210 : Math.round(rect.width);
          var height = rect === null ? 30 : Math.round(rect.height);
          var x = posRef.current === null ? 16 : posRef.current.x;
          var y = posRef.current === null ? 16 : posRef.current.y;
          store.rememberTickerBox({ x: x, y: y, w: width, h: height, dock: false });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        return function () {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
        };
      },
      [store],
    );

    if (state.tickerOpen !== true) return null;

    var quote = state.quote;
    var price = quote ? (quote.quote && isFinite(quote.quote.price) ? quote.quote.price : lastClose(quote)) : null;
    var preClose = baselineOf(quote);
    var change = price !== null && preClose !== null && preClose > 0 ? price - preClose : null;
    var pct = change !== null ? (change / preClose) * 100 : null;
    var color = change === null ? '#2b2b2b' : change > 0 ? UP : change < 0 ? DOWN : '#2b2b2b';

    var style =
      pos === null
        ? { right: '16px', bottom: '16px' }
        : { left: Math.round(pos.x) + 'px', top: Math.round(pos.y) + 'px' };

    return h(
      'div',
      {
        className: 'dsk-ticker',
        ref: boxRef,
        // 尺寸、布局、配色**全部内联**：不依赖任何样式表是否命中。
        // 背景透明、无边框、无阴影、无内边距 —— 就是一个贴在桌面上的文字标签。
        style: Object.assign({}, style, {
          display: 'block',
          width: 'auto',
          height: 'auto',
          padding: '0',
          margin: '0',
          border: 'none',
          borderRadius: '0',
          boxSizing: 'border-box',
          background: 'transparent',
          backgroundColor: 'transparent',
          boxShadow: 'none',
          fontFamily: '"Microsoft YaHei UI","Segoe UI","PingFang SC",sans-serif',
          color: INK,
          // 浮层里这两个属性最容易被上层改成透明：这里和所有子元素一起钉死
          WebkitTextFillColor: INK,
          opacity: 1,
          visibility: 'visible',
          userSelect: 'none',
          cursor: 'grab',
          overflow: 'visible',
          lineHeight: 0,
        }),
        title: '按住拖动可以移动；双击回到右下角',
        onPointerDown: startDrag,
        onPointerEnter: function () {
          setHovered(true);
        },
        onPointerLeave: function () {
          setHovered(false);
        },
        onDoubleClick: function () {
          store.rememberTickerBox({ dock: true });
        },
      },
      h(
        'div',
        {
          className: 'dsk-tickerMain',
          style: {
            display: 'block',
            position: 'relative',
            top: 0,
            left: 0,
            margin: 0,
            padding: 0,
            border: 0,
            background: 'transparent',
            backgroundColor: 'transparent',
            cursor: 'grab',
            touchAction: 'none',
            lineHeight: 0,
            opacity: 1,
            visibility: 'visible',
            color: INK,
            WebkitTextFillColor: INK,
            width: 'auto',
            height: 'auto',
          },
          title: '打开行情面板',
          onClick: function () {
            // 拖动结束的那一下不要误触发打开面板
            if (movedRef.current) return;
            openPanel();
          },
        },
        // 内容整体由 SVG 画出（不受 HTML 文本颜色规则影响）；
        // 关闭按钮也画在同一个 SVG 里，避免依赖字体里有没有 × 字形。
        h(TickerSvg, {
          quote: quote,
          pct: pct,
          color: color,
          hovered: hovered,
          onClose: function () {
            store.setTickerOpen(false);
          },
        }),
      ),
    );
  }

  return { PriceTicker: PriceTicker, TickerSvg: TickerSvg };
    };

    // ===================== skin =====================
    __factories["skin"] = function () {
  var react = require('react');
  var h = require('react').createElement;
  var useState = require('react').useState;
  var useEffect = require('react').useEffect;
  var useRef = require('react').useRef;
  var useMemo = require('react').useMemo;
  var useCallback = require('react').useCallback;
  var useSyncExternalStore = require('react').useSyncExternalStore;
  var format = R("format");
  var fmtPrice = format.fmtPrice;
  var fmtLarge = format.fmtLarge;
  var fmtPct = format.fmtPct;
  var shortDate = format.shortDate;
  var dateLabel = format.dateLabel;
  var niceTicks = format.niceTicks;
  var movingAverage = format.movingAverage;
  var baselineOf = format.baselineOf;
  var lastClose = format.lastClose;
  var UP = format.UP;
  var DOWN = format.DOWN;
  var MA_COLORS = format.MA_COLORS;
  var INK = format.INK;
  var MUTED = format.MUTED;
  var HALO = format.HALO;
  var MIN_VISIBLE_BARS = format.MIN_VISIBLE_BARS;
  var MAX_VISIBLE_BARS = format.MAX_VISIBLE_BARS;
  var DEFAULT_VISIBLE_BARS = format.DEFAULT_VISIBLE_BARS;
  var ZOOM_STEP = format.ZOOM_STEP;
  var clampVisibleBars = format.clampVisibleBars;
  var zoomStepsToCount = format.zoomStepsToCount;
  var market = R("market");
  var createStore = market.createStore;
  var useStore = market.useStore;
  var REFRESH_MS_BY_PERIOD = market.REFRESH_MS_BY_PERIOD;
  var refreshIntervalFor = market.refreshIntervalFor;
  /**
   * 对话页面背景 K 线
   *
   * 把 K 线作为**背景**铺在对话页面内容底下（不是浮在内容上面）。
   *
   * ## 目标容器（读 ui-layout / ui-conversation 源码后确认的事实）
   *
   *   .frame（grid；position:relative；overflow:hidden）
   *     ├ .sidebarCol
   *     ├ .centerCol                      ← 外层栏（**不能只挂这里**）
   *     │    └ .<hash>_root[data-phase]   ← 对话页面容器（ConversationMainPanel 的根）
   *     │         ├ conversation.header
   *     │         └ conversation.content
   *     ├ .rightbarCol
   *     └ .overlayLayer（z-index:20；pointer-events:none）
   *
   * 关键点：对话页面容器自己的 CSS 是
   *   `.<root>{background:var(--dsw-alias-bg-base); height:100%; display:flex;
   *            position:relative}`
   * 也就是说**它自带一层不透明底色**。皮肤若挂在它的父级 `.centerCol` 上，
   * 会被这层底色整个盖住（现象：怎么调都看不见）。
   * 所以必须挂进**它自己内部** —— 它是 `position:relative`，皮肤
   * `absolute + z-index:0` 正好落在它的底色之上、对话内容之下。
   *
   * ## 三个必须守住的点（都是踩过的坑）
   *
   * 1. **归属校验**：每次对账都从整篇文档清掉不在目标容器里的旧层。
   *    插件改过目标容器，旧层留在别处会导致"改了没效果"。
   * 2. **尺寸按容器实测值**：整屏宽的对话区要能铺满，并由 `overflow:hidden` 不越界。
   * 3. **可诊断**：层的 `title` 写明"宿主容器 / 实测尺寸"，鼠标悬停即可确认。
   */

  var SKIN_MARK = 'data-dsk-skin';

  /** 对话页面容器：ui-conversation 的 ConversationMainPanel 根节点带 `data-phase`。 */
  function findConversationPage(doc) {
    var byPhase = doc.querySelector('[data-phase][class*="root"]');
    if (byPhase !== null && byPhase !== undefined) return byPhase;
    var byPhaseOnly = doc.querySelector('[data-phase]');
    if (byPhaseOnly !== null && byPhaseOnly !== undefined) return byPhaseOnly;

    // 兜底：中心列里那个元素子节点（也就是面板根）
    var column = doc.querySelector('[class*="centerCol"]');
    if (column === null || column === undefined || column.children === undefined) return column;
    for (var i = 0; i < column.children.length; i++) {
      var child = column.children[i];
      if (child.hasAttribute && child.hasAttribute(SKIN_MARK)) continue;
      if (child.tagName !== undefined) return child;
    }
    return column;
  }

  /** 已挂载皮肤实例的同步函数集合（数据变化时立即重画，不依赖 window resize）。 */
  var activeSyncers = [];

  /** 请求所有皮肤实例立即对账 + 重画。 */
  function requestSkinRepaint() {
    for (var i = 0; i < activeSyncers.length; i++) {
      try {
        activeSyncers[i]();
      } catch (error) {
        /* 单个实例异常不影响其它实例 */
      }
    }
  }

  /**
   * 应用皮肤。
   *
   * @param {object} options
   * @param {Document} [options.doc] 文档对象（测试可注入替身）
   * @param {(w:number,h:number)=>string} options.render 绘制函数
   * @param {()=>boolean} [options.isActive] 返回 false 时隐藏（不卸载）
   * @param {()=>string} options.revision 数据指纹，变了才重画
   * @returns {() => void} disposer
   */
  function applyPageSkin(options) {
    var doc = options.doc === undefined || options.doc === null ? (typeof document === 'undefined' ? undefined : document) : options.doc;
    if (doc === undefined || doc.body === null || doc.body === undefined) return function () {};

    var view = doc.defaultView === undefined || doc.defaultView === null ? null : doc.defaultView;
    var Observer =
      view !== null && view.MutationObserver !== undefined
        ? view.MutationObserver
        : typeof MutationObserver === 'undefined'
          ? undefined
          : MutationObserver;
    if (Observer === undefined) return function () {};

    var disposed = false;
    var layer = null;
    var host = null;
    var lastKey = '';
    // 上次真正绘制时的尺寸与数据指纹（用于"小幅变化不重画"的判断）
    var lastWidth = 0;
    var lastHeight = 0;
    var lastRevision = '';
    // 节流用：上次同步时间与待执行的补一次定时器
    var lastSyncAt = 0;
    var pendingTimer = null;

    /**
     * 两次真正 sync 之间的最小间隔（毫秒）。
     *
     * 拖动侧栏时事件是逐帧来的（~16ms 一次）。50ms 意味着最多每 3 帧同步一次，
     * 视觉上完全看不出延迟，但把逐帧的布局 + 拼串开销砍掉约 2/3；
     * 拖完那一刻会补一次，所以松手后位置一定正确。
     */
    var SYNC_MIN_GAP_MS = 50;

    /** 用整篇文档的范围找所有皮肤层（兼容旧版本留在别处的）。 */
    function allLayers() {
      if (typeof doc.querySelectorAll === 'function') {
        var found = doc.querySelectorAll('[' + SKIN_MARK + ']');
        if (found !== null && found !== undefined) return found;
      }
      var out = [];
      var walk = function (node) {
        if (node === null || node === undefined || node.children === undefined) return;
        for (var i = 0; i < node.children.length; i++) {
          var child = node.children[i];
          if (child.hasAttribute && child.hasAttribute(SKIN_MARK)) out.push(child);
          walk(child);
        }
      };
      walk(doc.body);
      return out;
    }

    /** 造一层皮肤。 */
    function createLayer() {
      var created = doc.createElement('div');
      created.setAttribute(SKIN_MARK, '');
      created.style.cssText =
        'position:absolute;inset:0;z-index:0;pointer-events:none;overflow:hidden;display:block;opacity:0.5';
      var holder = doc.createElement('div');
      holder.style.cssText = 'width:100%;height:100%;display:block';
      created.appendChild(holder);
      return created;
    }

    /**
     * 让 DOM 与目标一致：清掉别处的旧层、在对话页面容器里放好唯一一层。
     *
     * ## 为什么这里必须"便宜"（拖动侧边栏会卡顿的根因）
     *
     * 拖动侧栏边框时，壳层**每帧**都在改 `.frame` 的 `grid-template-columns`，
     * 于是 `MutationObserver` 每帧触发一次。而这个函数里原本有一次
     * 全文档 `querySelectorAll('[data-dsk-skin]')` —— 在一棵很大的 DOM 上反复跑，
     * 加上后面 `paint()` 读 `clientWidth` 触发强制 layout，就变成了逐帧卡顿。
     *
     * 所以这里改成：**先做一次极廉价的判断**（层是否已经在当前宿主里），
     * 只有真的需要搬家时才去扫全文档。
     */
    function reconcile() {
      if (disposed) return;
      var page = findConversationPage(doc);
      if (page === null || page === undefined) return;

      // 快路径：层已经在目标容器里 —— 最常见的情况，一次引用比较就结束。
      // 注意 `host === page` 也要判：宿主节点本身被 React 换掉时同样需要搬家。
      if (layer !== null && layer.parentNode === page && host === page) return;

      var layers = allLayers();
      var mine = null;
      for (var i = 0; i < layers.length; i++) {
        var node = layers[i];
        if (node === null || node === undefined) continue;
        if (node.parentNode === page) {
          if (mine === null) mine = node;
          else if (node.parentNode !== null) node.parentNode.removeChild(node);
          continue;
        }
        if (node.parentNode !== null && node.parentNode !== undefined) node.parentNode.removeChild(node);
      }

      if (mine === null) {
        mine = createLayer();
        if (page.firstChild === null || page.firstChild === undefined) page.appendChild(mine);
        else page.insertBefore(mine, page.firstChild);
        lastKey = '';
      }
      layer = mine;
      host = page;
    }

    /**
     * 重画；返回可读诊断信息（挂在层 title 上）。
     *
     * 尺寸变化有个**阈值**：拖动时宽度每帧都在变，若无条件重画，每帧都要
     * 重新拼一整张 SVG 字符串 + `innerHTML`，这正是卡顿的主要来源。
     * SVG 用 `preserveAspectRatio="none"`，宽度变了它会自己拉伸，
     * 所以小幅变化完全不需要重画 —— 只有变化超过 3% 才重新生成。
     */
    function paint() {
      if (disposed || layer === null || layer.parentNode === null) return '';
      var active = typeof options.isActive === 'function' ? options.isActive() === true : true;
      layer.style.display = active ? 'block' : 'none';
      if (!active) return '';

      var width = Math.round(layer.clientWidth);
      var height = Math.round(layer.clientHeight);
      if (!isFinite(width) || width <= 0) width = 720;
      if (!isFinite(height) || height <= 0) height = 600;

      var hostClass = host === null || host === undefined ? '?' : String(host.className || '').split(' ')[0];
      var info = 'K线背景 · 宿主=' + hostClass + ' · ' + width + '×' + height;
      if (layer.title !== info) layer.title = info;

      var revision = options.revision();
      // 已经画过，且宽高变化都在 3% 以内、数据也没变 → 交给 CSS 拉伸，不重画
      if (
        lastKey !== '' &&
        revision === lastRevision &&
        Math.abs(width - lastWidth) <= Math.max(8, lastWidth * 0.03) &&
        Math.abs(height - lastHeight) <= Math.max(8, lastHeight * 0.03)
      ) {
        return info;
      }

      var markup = options.render(width, height);
      if (typeof markup === 'string' && markup !== '') {
        var holder = layer.firstChild;
        if (holder !== null && holder !== undefined) {
          holder.innerHTML = markup;
          lastKey = width + 'x' + height + ':' + revision;
          lastWidth = width;
          lastHeight = height;
          lastRevision = revision;
        }
      }
      return info;
    }

    function sync() {
      reconcile();
      paint();
    }

    /**
     * 节流后的同步。
     *
     * 拖动期间事件是逐帧来的，直接跑 `sync()` 等于每帧一次布局 + 拼串。
     * 这里保证**两次真正执行之间至少隔 SYNC_MIN_GAP_MS**，
     * 拖完那一刻再补一次，所以松手后位置一定是对的。
     */
    function requestSync() {
      if (disposed) return;
      var now = Date.now();
      var elapsed = now - lastSyncAt;
      if (elapsed >= SYNC_MIN_GAP_MS) {
        lastSyncAt = now;
        sync();
        return;
      }
      if (pendingTimer !== null) return;
      pendingTimer = (view !== null && typeof view.setTimeout === 'function' ? view.setTimeout : setTimeout)(
        function () {
          pendingTimer = null;
          lastSyncAt = Date.now();
          sync();
        },
        SYNC_MIN_GAP_MS - elapsed,
      );
    }

    sync();
    activeSyncers.push(requestSync);

    // 只观察 `childList`（层被 React 挪走 / 面板切换），**不观察 attributes**。
    // 拖动侧栏改的是 .frame 的内联 style（子树的 attributes 变化），
    // 那类变化对"层还在不在"没有影响，却会每帧触发回调 —— 不订阅就没有这个开销。
    var observer = new Observer(function () {
      requestSync();
    });
    observer.observe(doc.body, { childList: true, subtree: true });

    var onResize = function () {
      requestSync();
    };
    if (view !== null) view.addEventListener('resize', onResize);
    // 侧栏开合/拖动改宽不一定触发 window resize：低频轮询兜底
    var timer = view !== null && typeof view.setInterval === 'function' ? view.setInterval(sync, 1200) : null;

    return function () {
      disposed = true;
      observer.disconnect();
      if (pendingTimer !== null) {
        var clear = view !== null && typeof view.clearTimeout === 'function' ? view.clearTimeout : clearTimeout;
        clear(pendingTimer);
        pendingTimer = null;
      }
      var index = activeSyncers.indexOf(requestSync);
      if (index >= 0) activeSyncers.splice(index, 1);
      if (view !== null) view.removeEventListener('resize', onResize);
      if (timer !== null && view !== null) view.clearInterval(timer);
      if (layer !== null && layer.parentNode !== null) layer.parentNode.removeChild(layer);
      layer = null;
      host = null;
    };
  }

  /**
   * 皮肤控制器：壳层里的隐形组件（自己返回 null）。
   *
   * 用 `usePanelInfo` 判断"当前主面板是不是对话"：切到插件页/设置页要隐藏，
   * 否则 K 线会透到那些页面底下。
   */
  function SkinController(props) {
    var store = props.store;
    var state = useStore(store);

    var panelActive = null;
    if (typeof props.usePanelInfo === 'function') {
      panelActive = props.usePanelInfo(function (info) {
        return info.activePanelId === null;
      });
    }

    useEffect(
      function () {
        var dispose = applyPageSkin({
          render: function (width, height) {
            return renderSkinSvg(store.get(), width, height);
          },
          isActive: function () {
            var snapshot = store.get();
            if (snapshot.skinOpen !== true) return false;
            return panelActive !== false;
          },
          revision: function () {
            var snapshot = store.get();
            var quote = snapshot.quote;
            var tail = quote && quote.candles && quote.candles.length > 0 ? quote.candles[quote.candles.length - 1] : null;
            return (
              (quote ? quote.code : '-') +
              '|' +
              snapshot.period +
              '|' +
              (tail ? tail.date + ':' + tail.close : '-') +
              '|' +
              (snapshot.skinOpen === true ? 'on' : 'off') +
              // ⚠️ zoom 必须进这个 key，否则主面板滚轮缩放时 revision 不变 →
              // 背景不会重绘 → 同步形同失效（画面还是旧根数）。
              '|z' +
              snapshot.zoom
            );
          },
        });
        return dispose;
      },
      [store, panelActive],
    );

    // 换股票/周期、开关皮肤、或主面板改变缩放时，立刻重画一次。
    // zoom 在这里的作用是"即时"—— 即使 revision 已经带上了 zoom，
    // 主动请求一次重画能让同步没有那 1.2 秒的轮询延迟。
    useEffect(
      function () {
        requestSkinRepaint();
      },
      [state.symbol, state.period, state.skinOpen, state.zoom],
    );

    return null;
  }

  /**
   * 把行情画成背景皮肤（SVG 字符串）。
   *
   * 只画蜡烛 + 成交量淡影 + MA5/20/60 + 一条昨收虚线，**不画任何坐标文字**：
   * 它是背景纹理，不能抢正文的可读性。
   * 蜡烛根数按宽度自适应；右侧留白避免最后一根贴边。
   */
  function renderSkinSvg(snapshot, width, height) {
    var quote = snapshot === undefined || snapshot === null ? null : snapshot.quote;
    if (quote === null || quote === undefined || !quote.candles || quote.candles.length === 0) return '';

    var w = Math.max(80, Math.round(width));
    var h = Math.max(120, Math.round(height));

    var padTop = Math.round(h * 0.08);
    var padBottom = Math.round(h * 0.08);
    var plotH = Math.max(80, h - padTop - padBottom);

    // 横向：最右那根 K 线要和右边界留出间距（否则像"以起点为准压扁"）
    var padRight = Math.max(16, Math.min(64, Math.round(w * 0.07)));
    var plotW = Math.max(40, w - padRight);

    /**
     * 可见根数跟随**主面板的缩放维度**（store.zoom）。
     *
     * 之前这里按自身宽度自适应（`plotW / 8`），于是背景和主面板各画各的：
     * 主面板放大到只看最近 20 根，背景却still画 160 根，两边不是同一段行情。
     * 现在统一读 snapshot.zoom —— 主面板滚轮缩放，背景立刻跟着显示同一段。
     *
     * 仍然保留一个**基于自身宽度的上限**：背景是窄条，若主面板看了 240 根而这里
     * 只有 280px，每根不到 1.2px 会糊成一片色。上限取 `max(24, plotW/8)`
     * 既能保证"放大时完全一致"，又不会让缩小到极限时糊掉。
     */
    var panelZoom = snapshot === null || snapshot === undefined ? undefined : snapshot.zoom;
    var widthCap = Math.max(24, Math.floor(plotW / 8));
    var count =
      typeof panelZoom === 'number' && isFinite(panelZoom) && panelZoom > 0
        ? Math.min(clampVisibleBars(panelZoom, quote.candles.length), widthCap)
        : widthCap;
    var candles = quote.candles.slice(-count);
    if (candles.length === 0) return '';

    var step = plotW / candles.length;

    var min = Infinity;
    var max = -Infinity;
    var maxVolume = 0;
    candles.forEach(function (candle) {
      if (candle.low < min) min = candle.low;
      if (candle.high > max) max = candle.high;
      if (candle.volume > maxVolume) maxVolume = candle.volume;
    });
    if (!isFinite(min) || !isFinite(max)) return '';
    var range = max - min;
    if (range <= 0) range = Math.max(0.01, Math.abs(max) * 0.002);

    var y = function (value) {
      return padTop + (1 - (value - min) / range) * plotH;
    };
    var xOf = function (index) {
      return index * step + step / 2;
    };
    var volBase = padTop + plotH;
    var volH = plotH * 0.16;
    var bodyW = Math.max(1, Math.min(24, step * 0.62));

    var parts = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="' +
        w +
        '" height="' +
        h +
        '" viewBox="0 0 ' +
        w +
        ' ' +
        h +
        '" preserveAspectRatio="none">',
    ];

    candles.forEach(function (candle, index) {
      var x = xOf(index);
      var up = candle.close >= candle.open;
      var color = up ? UP : DOWN;
      var bodyTop = y(Math.max(candle.open, candle.close));
      var bodyBottom = y(Math.min(candle.open, candle.close));
      parts.push(
        '<line x1="' +
          x.toFixed(1) +
          '" x2="' +
          x.toFixed(1) +
          '" y1="' +
          y(candle.high).toFixed(1) +
          '" y2="' +
          y(candle.low).toFixed(1) +
          '" stroke="' +
          color +
          '" stroke-width="1" stroke-opacity="0.5"/>',
      );
      parts.push(
        '<rect x="' +
          (x - bodyW / 2).toFixed(1) +
          '" y="' +
          bodyTop.toFixed(1) +
          '" width="' +
          bodyW.toFixed(1) +
          '" height="' +
          Math.max(1, bodyBottom - bodyTop).toFixed(1) +
          '" fill="' +
          color +
          '" fill-opacity="0.42"/>',
      );
      if (maxVolume > 0) {
        var barH = Math.max(1, (candle.volume / maxVolume) * volH);
        parts.push(
          '<rect x="' +
            (x - bodyW / 2).toFixed(1) +
            '" y="' +
            (volBase - barH).toFixed(1) +
            '" width="' +
            bodyW.toFixed(1) +
            '" height="' +
            barH.toFixed(1) +
            '" fill="' +
            color +
            '" fill-opacity="0.16"/>',
        );
      }
    });

    // 均线：给背景一点层次，同样低透明度
    [5, 20, 60].forEach(function (size, order) {
      var color = MA_COLORS[order % MA_COLORS.length];
      var points = [];
      var sum = 0;
      for (var i = 0; i < candles.length; i++) {
        sum += candles[i].close;
        if (i >= size) sum -= candles[i - size].close;
        if (i < size - 1) continue;
        points.push(xOf(i).toFixed(1) + ',' + y(sum / size).toFixed(1));
      }
      if (points.length < 2) return;
      parts.push(
        '<polyline points="' +
          points.join(' ') +
          '" fill="none" stroke="' +
          color +
          '" stroke-width="1.4" stroke-opacity="0.3"/>',
      );
    });

    // 昨收基准虚线：只画到绘图区右边界
    var preClose = baselineOf({ candles: candles, preClose: quote.preClose });
    if (preClose === null) preClose = candles[candles.length - 1].close;
    parts.push(
      '<line x1="0" x2="' +
        plotW.toFixed(1) +
        '" y1="' +
        y(preClose).toFixed(1) +
        '" y2="' +
        y(preClose).toFixed(1) +
        '" stroke="currentColor" stroke-opacity="0.12" stroke-dasharray="6 6"/>',
    );
    parts.push('</svg>');
    return parts.join('');
  }

  return {
    SkinController: SkinController,
    applyPageSkin: applyPageSkin,
    renderSkinSvg: renderSkinSvg,
    requestSkinRepaint: requestSkinRepaint,
  };
    };

    // ===================== chart-panel =====================
    __factories["chart-panel"] = function () {
  var react = require('react');
  var h = require('react').createElement;
  var useState = require('react').useState;
  var useEffect = require('react').useEffect;
  var useRef = require('react').useRef;
  var useMemo = require('react').useMemo;
  var useCallback = require('react').useCallback;
  var useSyncExternalStore = require('react').useSyncExternalStore;
  var format = R("format");
  var fmtPrice = format.fmtPrice;
  var fmtLarge = format.fmtLarge;
  var fmtPct = format.fmtPct;
  var shortDate = format.shortDate;
  var dateLabel = format.dateLabel;
  var niceTicks = format.niceTicks;
  var movingAverage = format.movingAverage;
  var baselineOf = format.baselineOf;
  var lastClose = format.lastClose;
  var UP = format.UP;
  var DOWN = format.DOWN;
  var MA_COLORS = format.MA_COLORS;
  var INK = format.INK;
  var MUTED = format.MUTED;
  var HALO = format.HALO;
  var MIN_VISIBLE_BARS = format.MIN_VISIBLE_BARS;
  var MAX_VISIBLE_BARS = format.MAX_VISIBLE_BARS;
  var DEFAULT_VISIBLE_BARS = format.DEFAULT_VISIBLE_BARS;
  var ZOOM_STEP = format.ZOOM_STEP;
  var clampVisibleBars = format.clampVisibleBars;
  var zoomStepsToCount = format.zoomStepsToCount;
  var chart = R("chart");
  var KlineChart = chart.KlineChart;
  var market = R("market");
  var createStore = market.createStore;
  var useStore = market.useStore;
  var REFRESH_MS_BY_PERIOD = market.REFRESH_MS_BY_PERIOD;
  var refreshIntervalFor = market.refreshIntervalFor;
  var indices = R("indices");
  var INDEXES = indices.INDEXES;
  var INDEX_GROUPS = indices.INDEX_GROUPS;
  var indexByCode = indices.indexByCode;
  var prefs = R("prefs");
  var API = prefs.API;
  var LOCAL_KEY = prefs.LOCAL_KEY;
  var PREF_KEYS = prefs.PREF_KEYS;
  var loadLocalPrefs = prefs.loadLocalPrefs;
  var saveLocalPrefs = prefs.saveLocalPrefs;
  /**
   * 行情主面板（整页大图）
   *
   * ## 图表上方的三行（每行单一职责，不要混）
   *
   * ```
   * 沪深300 000300   4313.77 +13.01 +0.30%        [东财] [10:27:22]   ← ① 行情行
   * [分时|5分|…|月K]  │  [搜索框] [刷新] [浮窗 开] [皮肤 开]           ← ② 工具行
   * 指数 [沪深300][中证500][上证50][深证成指][创业板指][中小100]        ← ③ 快捷标的行
   * ```
   *
   * 为什么分行：早先这三样东西挤在**同一个 flex 行**里（靠 `flex-wrap` 偶然折成两行），
   * 宽度一变就重新洗牌 —— 周期按钮可能跑到标题旁边，开关可能被挤到下一行。
   * 现在每行是明确的语义组，换行只发生在组**内部**。
   *
   * 行内顺序也有讲究：
   *   · ① 左边是"我在看什么、现在多少钱"，右边是**数据元信息**（来源 + 时间）——
   *     都是"这批数字可不可信"的线索，所以成对放右边；
   *   · ② 左边是**选择**（周期），右边是**动作**（搜索/刷新/显示开关），中间一条竖线分开；
   *   · ③ 是切标的的快捷方式，独立一行，不和时间/开关抢位置。
   *
   * ## 选股票的两种方式
   *
   *   · **常见指数**：③ 那排按钮，点一下就切（清单在 `indices.js`，与宿主共用一份）
   *   · **其他股票**：② 的搜索框里输代码 / 中文名 / 拼音（`600519`、`贵州茅台`、`gzmt`）
   *
   * 入口是 sidebar.panellist 的「行情 K 线」图标（部分构建里那排图标不渲染，故为备用入口）。
   *
   * 已按需求移除：自选股、刷新间隔选择。
   */

  /** 周期选项。 */
  var PERIOD_ROWS = [
    { id: 'minute', label: '分时' },
    { id: '5', label: '5分' },
    { id: '15', label: '15分' },
    { id: '30', label: '30分' },
    { id: '60', label: '60分' },
    { id: 'day', label: '日K' },
    { id: 'week', label: '周K' },
    { id: 'month', label: '月K' },
  ];

  /**
   * 股票搜索框：输入即自动联想，结果列在下方。
   *
   * ## 为什么必须有 `status`
   *
   * 原来的实现没有"请求进行中"这个概念，`items` 在路上时就是空数组，
   * 于是下拉里**立刻**显示「没有匹配（回车按输入尝试）」——
   * 而它其实只是"还没回来"。用户看到的就是"输入时总显示没有匹配"。
   *
   * 现在把三件事分开：
   *   · `status === 'loading'` → 显示「搜索中…」，不下任何结论；
   *   · `status === 'done'` 且结果为空 → 才显示「没有匹配」；
   *   · 有结果 → 列出候选。
   *
   * 另外每次查询开始就**清掉上一轮结果**：否则在新关键词下会短暂显示**别的股票**，
   * 那比空列表更糟（用户可能顺手点错）。
   *
   * 搜索栏的用途是**找具体个股**（指数有面板上那排快捷按钮）。宿主侧走腾讯 smartbox，
   * 它不认指数 —— 这是已知且有意的取舍。
   */
  function SymbolSearch(props) {
    var onPick = props.onPick;
    var current = props.current;
    // compact = 窄输入框：只在有输入时才展开候选（否则候选会把布局顶开）
    var compact = props.compact === true;
    var openPair = useState(false);
    var open = openPair[0];
    var setOpen = openPair[1];
    var textPair = useState('');
    var text = textPair[0];
    var setText = textPair[1];
    var itemsPair = useState([]);
    var items = itemsPair[0];
    var setItems = itemsPair[1];
    /** 'idle'（还没查）| 'loading'（在路上）| 'done'（已定论） */
    var statusPair = useState('idle');
    var status = statusPair[0];
    var setStatus = statusPair[1];
    /** 键盘高亮的下标，-1 表示没有高亮（此时回车走"直接查询"）。 */
    var activePair = useState(-1);
    var active = activePair[0];
    var setActive = activePair[1];
    var boxRef = useRef(null);

    // 去掉首尾空白：只输空格不算改查询，不该重新发请求
    var query = text.trim();
    var exact = items.some(function (row) {
      return row.code === query;
    });

    useEffect(
      function () {
        if (!open) return undefined;
        var handler = function (event) {
          var node = boxRef.current;
          if (node !== null && !node.contains(event.target)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return function () {
          document.removeEventListener('mousedown', handler);
        };
      },
      [open],
    );

    /**
     * 输入变化 → 自动搜索。
     *
     * 依赖是 `query`（已 trim）而不是 `text`：这样输入尾部空格不会重发请求。
     * 防抖 120ms，外加 `cancelled` 保证**只有最后一次**查询的结果能落地。
     */
    useEffect(
      function () {
        if (!open) return undefined;
        if (query === '') {
          setItems([]);
          setStatus('idle');
          return undefined;
        }
        // 立刻清掉上一轮：避免新关键词下短暂显示别的股票
        setItems([]);
        setActive(-1);
        setStatus('loading');
        var cancelled = false;
        var timer = window.setTimeout(function () {
          fetch(API + '/search?q=' + encodeURIComponent(query) + '&limit=12')
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              if (cancelled) return;
              setItems((body && body.items) || []);
              setStatus('done');
            })
            .catch(function () {
              if (cancelled) return;
              setItems([]);
              setStatus('done');
            });
        }, 120);
        return function () {
          cancelled = true;
          window.clearTimeout(timer);
        };
      },
      [query, open],
    );

    function submit(value) {
      if (!value) return;
      onPick(value);
      setOpen(false);
      setText('');
      setItems([]);
      setStatus('idle');
      setActive(-1);
    }

    /** 下拉内容：空的、在查、有结果、以及「直接查询」兜底，四种情况都给出反馈。 */
    var menuChildren = [];
    if (query === '') {
      menuChildren.push(
        h('div', { className: 'dsk-menuNote', key: 'hint' }, '输入代码或名称，例如 600519 / 贵州茅台 / gzmt'),
      );
    } else {
      if (items.length === 0) {
        menuChildren.push(
          // 只有**搜索已结束**才敢说"没有匹配"。
          // 'idle'（还没发请求）和 'loading'（在路上）都只是"还没定论" ——
          // 早先不分状态就在这里下结论，用户看到的就是"输入时总显示没有匹配"。
          status === 'done'
            ? h('div', { className: 'dsk-menuNote', key: 'empty' }, '没有匹配，可回车直接尝试')
            : h('div', { className: 'dsk-menuNote', key: 'loading' }, h('span', { className: 'dsk-spin' }), '搜索中…'),
        );
      }
      items.forEach(function (item, index) {
        menuChildren.push(
          h(
            'button',
            {
              key: item.prefix + item.code,
              type: 'button',
              className: 'dsk-menuItem',
              'data-active': index === active ? '1' : '0',
              // 鼠标移入也同步高亮：键盘和鼠标共用同一套"当前项"
              onMouseEnter: function () {
                setActive(index);
              },
              onClick: function () {
                submit(item.code);
              },
            },
            h('span', { className: 'dsk-menuName' }, item.name),
            h('span', { className: 'dsk-menuCode' }, item.code + '.' + String(item.prefix).toUpperCase()),
          ),
        );
      });
      // 结果里没有精确同码时，给一个明确的"直接查这个输入"入口 ——
      // 以前只有回车能触发，用户根本不知道（这正是提示语里那句"回车按输入尝试"的由来）。
      if (!exact) {
        menuChildren.push(
          h(
            'button',
            {
              key: 'direct',
              type: 'button',
              className: 'dsk-menuItem dsk-menuDirect',
              onClick: function () {
                submit(query);
              },
            },
            h('span', { className: 'dsk-menuName' }, '直接查询「' + query + '」'),
          ),
        );
      }
    }

    return h(
      'div',
      { className: 'dsk-search', ref: boxRef },
      h('input', {
        className: 'dsk-input',
        value: text,
        placeholder: compact ? current : current + ' · 代码或名称',
        onFocus: function () {
          setOpen(true);
        },
        onChange: function (event) {
          setText(event.target.value);
          setOpen(true);
        },
        onKeyDown: function (event) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(function (prev) {
              return items.length === 0 ? -1 : Math.min(items.length - 1, prev + 1);
            });
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(function (prev) {
              return Math.max(-1, prev - 1);
            });
            return;
          }
          if (event.key === 'Enter') {
            // 有高亮就选它，否则直接查输入内容
            var picked = active >= 0 && active < items.length ? items[active] : null;
            submit(picked === null ? query : picked.code);
            return;
          }
          if (event.key === 'Escape') setOpen(false);
        },
      }),
      open && (compact ? query !== '' : true) ? h('div', { className: 'dsk-menu' }, menuChildren) : null,
    );
  }

  function StockPanel(props) {
    var store = props.store;
    var state = useStore(store);
    var quote = state.quote;

    // 首次渲染拉一次，并让定时器跟随当前刷新间隔
    useEffect(
      function () {
        store.refresh();
      },
      [store, state.symbol, state.period],
    );

    // 切换股票/周期时立刻取数（selectSymbol/setPeriod 内部已触发，这里兜底首次挂载后的变更）
    useEffect(
      function () {
        if (state.quote === null && state.error === null) store.refresh();
      },
      [state.symbol, state.period],
    );

    var price = quote ? quote.quote && isFinite(quote.quote.price) ? quote.quote.price : lastClose(quote) : null;
    var preClose = baselineOf(quote);
    var change = price !== null && preClose !== null && preClose > 0 ? price - preClose : null;
    var changePct = change !== null ? (change / preClose) * 100 : null;
    var color = change === null ? 'inherit' : change > 0 ? UP : change < 0 ? DOWN : 'inherit';

    /**
     * 常见指数快捷行 —— 按**市场分组**显示（沪深 / 港股 / 美股）。
     *
     * 为什么单独做一排：指数和白马股是两类完全不同的入口 ——
     * 指数就那么几个、天天看，应该一次点击直达；而个股有几千个，只能靠搜索。
     * 清单来自 `indices.js`（与宿主共用一份），不要在这里另写一张表。
     *
     * 为什么分组：加了港股/美股之后一共 11 个按钮，平铺一排会看不出哪个是哪个市场；
     * 分组标题（沪深/港股/美股）顺带说明了"这几个不是 A 股"，也解释了它们的
     * 周期限制（美股只有日/周/月）。
     */
    var indexRow = h(
      'div',
      { className: 'dsk-indexRow', key: 'indexes' },
      INDEX_GROUPS.map(function (group) {
        var rows = INDEXES.filter(function (row) {
          return row.group === group.id;
        });
        if (rows.length === 0) return null;
        return h('div', { className: 'dsk-indexGroup', key: group.id }, [
          h('span', { className: 'dsk-indexLabel', key: 'lb' }, group.label),
          h(
            'div',
            { className: 'dsk-tabs', key: 'tabs' },
            rows.map(function (row) {
              return h(
                'button',
                {
                  key: row.code,
                  type: 'button',
                  className: 'dsk-tab',
                  // 高亮当前选中的指数（个股时全部不高亮）
                  'data-on': state.symbol === row.code ? '1' : '0',
                  title: row.name + ' ' + row.code,
                  onClick: function () {
                    store.selectSymbol(row.code);
                  },
                },
                row.name,
              );
            }),
          ),
        ]);
      }),
    );

    /**
     * ① 行情行：标的名 + 代码 + 价格 + 涨跌，右侧成对放**数据元信息**（来源徽标、更新时间）。
     *
     * 元信息用一个 `.dsk-meta` 包起来而不是散着放：它们是"这批数字可不可信"的一组线索，
     * 应当同进同退（拿不到数据时一起不出现），也不该被标题挤散。
     */
    var sourceBadge = quote
      ? h(
          'span',
          {
            className: 'dsk-badge',
            key: 'src',
            title: quote.fallbackReason
              ? '同花顺不可用，已回落到 ' + (quote.source === 'tencent' ? '腾讯' : '东方财富') + '：' + quote.fallbackReason
              : '数据源：同花顺',
          },
          quote.source === 'ths' ? '同花顺' : quote.source === 'tencent' ? '腾讯' : '东财',
        )
      : null;
    var timeBadge =
      state.updatedAt > 0
        ? h(
            'span',
            { className: 'dsk-badge', key: 'upd' },
            new Date(state.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }),
          )
        : null;

    var quoteRow = h('div', { className: 'dsk-quoteRow', key: 'quoteRow' }, [
      h('div', { className: 'dsk-title', key: 'title' }, [
        h('span', { className: 'dsk-name', key: 'n' }, quote ? quote.name : '加载中'),
        h('span', { className: 'dsk-code', key: 'c' }, quote ? quote.code : ''),
      ]),
      price === null
        ? null
        : h('span', { className: 'dsk-price', key: 'p', style: { color: color } }, fmtPrice(price)),
      changePct === null
        ? null
        : h(
            'span',
            { className: 'dsk-chg', key: 'chg', style: { color: color } },
            (change >= 0 ? '+' : '') + fmtPrice(change) + ' ' + fmtPct(changePct),
          ),
      h('span', { className: 'dsk-spacer', key: 'sp' }),
      sourceBadge === null && timeBadge === null
        ? null
        : h('div', { className: 'dsk-meta', key: 'meta' }, [sourceBadge, timeBadge]),
    ]);

    /**
     * ② 工具行：左**选择**（周期）｜右**动作**（搜索 / 刷新 / 显示开关），中间竖线分隔。
     *
     * spacer 把动作组推到右边缘，让两行的节奏一致（行情行也是"左内容 + 右元信息"）。
     * 面板很窄时 spacer 被压成 0，动作组自然折到下一行，分组不会散。
     */
    var refreshBtn = h(
      'button',
      {
        key: 'refreshNow',
        type: 'button',
        // min-width 固定：加载时把文字换成转圈会让按钮宽度跳动，整行跟着抖
        className: 'dsk-btn dsk-btnRefresh',
        title: '立即重新拉取当前代码与周期的行情',
        onClick: function () {
          store.refresh();
        },
      },
      state.loading ? [h('span', { className: 'dsk-spin', key: 'sp' }), '刷新'] : '刷新',
    );

    var toolbarRow = h('div', { className: 'dsk-toolbar', key: 'toolbar' }, [
      h(
        'div',
        { className: 'dsk-tabs', key: 'periods' },
        PERIOD_ROWS.map(function (row) {
          return h(
            'button',
            {
              key: row.id,
              type: 'button',
              className: 'dsk-tab',
              'data-on': state.period === row.id ? '1' : '0',
              onClick: function () {
                store.setPeriod(row.id);
              },
            },
            row.label,
          );
        }),
      ),
      h('span', { className: 'dsk-spacer', key: 'sp' }),
      h('span', { className: 'dsk-vsep', key: 'sep' }),
      h('div', { className: 'dsk-actions', key: 'actions' }, [
        h(SymbolSearch, {
          key: 'search',
          current: state.symbol,
          onPick: function (value) {
            store.selectSymbol(value);
          },
        }),
        refreshBtn,
        // 两个显示开关都放在这里 —— 面板就是"行情 K 线页面"。
        //
        // 为什么回程入口必须落在面板自己身上：浮窗的 × 一关就再也叫不回来
        // （开关藏在齿轮里不好找）。浮窗是覆盖在别处的浮层，关掉它之后用户
        // 没法从浮窗回到面板，所以开关得在面板上。背景皮肤同理 —— 它就铺在
        // 对话底下，人在对话页时最想顺手开关它。
        //
        // 职责边界（很重要）：
        //   · `浮窗` 只管右下角浮窗显不显示；
        //   · `皮肤` 只管对话页铺不铺 K 线背景；
        //   · 两者是**独立字段**，互不影响；
        //   · **数据获取跟这两个开关都无关** —— 只要面板或背景皮肤还在，
        //     就持续按当前代码/周期取数。
        h(
          'button',
          {
            key: 'tickerToggle',
            type: 'button',
            className: 'dsk-btn',
            'data-on': state.tickerOpen === true ? '1' : '0',
            title: '只控制右下角浮窗的显示；背景皮肤与取数都不受影响',
            onClick: function () {
              store.setTickerOpen(!(state.tickerOpen === true));
            },
          },
          state.tickerOpen === true ? '浮窗 开' : '浮窗 关',
        ),
        h(
          'button',
          {
            key: 'skinToggle',
            type: 'button',
            className: 'dsk-btn',
            'data-on': state.skinOpen === true ? '1' : '0',
            title: '只控制对话页的 K 线背景；取数不受影响',
            onClick: function () {
              store.setSkinOpen(!(state.skinOpen === true));
            },
          },
          state.skinOpen === true ? '皮肤 开' : '皮肤 关',
        ),
      ]),
    ]);

    var head = h('div', { className: 'dsk-head', key: 'head' }, [quoteRow, toolbarRow]);

    var body;
    if (state.error !== null && quote === null) {
      body = h(
        'div',
        { className: 'dsk-state', key: 'err' },
        h('div', { className: 'dsk-stateErr' }, '行情获取失败：' + state.error),
        h(
          'button',
          {
            type: 'button',
            className: 'dsk-btn',
            onClick: function () {
              store.refresh();
            },
          },
          '重试',
        ),
      );
    } else if (quote === null) {
      body = h('div', { className: 'dsk-state', key: 'load' }, h('span', { className: 'dsk-spin' }), '正在取行情…');
    } else if (!quote.candles || quote.candles.length === 0) {
      body = h('div', { className: 'dsk-state', key: 'empty' }, '该周期没有数据');
    } else {
      body = h(KlineChart, {
        key: 'chart',
        quote: quote,
        period: state.period,
        ma: state.ma,
        height: '100%',
        // 缩放维度受控：主面板写进 store，对话背景读同一个值画同一段行情。
        zoom: state.zoom,
        onZoom: function (count) {
          store.setZoom(count, quote.candles.length);
        },
      });
    }

    return h('div', { className: 'dsk-root' }, [head, indexRow, body]);
  }

  return { SymbolSearch: SymbolSearch, StockPanel: StockPanel };
    };

    // ===================== plugin =====================
    __factories["plugin"] = function () {
  var react = require('react');
  var h = require('react').createElement;
  var useState = require('react').useState;
  var useEffect = require('react').useEffect;
  var useRef = require('react').useRef;
  var useMemo = require('react').useMemo;
  var useCallback = require('react').useCallback;
  var useSyncExternalStore = require('react').useSyncExternalStore;
  var styles = R("styles");
  var STYLE_TAG = styles.STYLE_TAG;
  var cssText = styles.cssText;
  var getCss = styles.getCss;
  var installCss = styles.installCss;
  var format = R("format");
  var fmtPrice = format.fmtPrice;
  var fmtLarge = format.fmtLarge;
  var fmtPct = format.fmtPct;
  var shortDate = format.shortDate;
  var dateLabel = format.dateLabel;
  var niceTicks = format.niceTicks;
  var movingAverage = format.movingAverage;
  var baselineOf = format.baselineOf;
  var lastClose = format.lastClose;
  var UP = format.UP;
  var DOWN = format.DOWN;
  var MA_COLORS = format.MA_COLORS;
  var INK = format.INK;
  var MUTED = format.MUTED;
  var HALO = format.HALO;
  var MIN_VISIBLE_BARS = format.MIN_VISIBLE_BARS;
  var MAX_VISIBLE_BARS = format.MAX_VISIBLE_BARS;
  var DEFAULT_VISIBLE_BARS = format.DEFAULT_VISIBLE_BARS;
  var ZOOM_STEP = format.ZOOM_STEP;
  var clampVisibleBars = format.clampVisibleBars;
  var zoomStepsToCount = format.zoomStepsToCount;
  var market = R("market");
  var createStore = market.createStore;
  var useStore = market.useStore;
  var REFRESH_MS_BY_PERIOD = market.REFRESH_MS_BY_PERIOD;
  var refreshIntervalFor = market.refreshIntervalFor;
  var ticker = R("ticker");
  var PriceTicker = ticker.PriceTicker;
  var TickerSvg = ticker.TickerSvg;
  var skin = R("skin");
  var SkinController = skin.SkinController;
  var applyPageSkin = skin.applyPageSkin;
  var renderSkinSvg = skin.renderSkinSvg;
  var requestSkinRepaint = skin.requestSkinRepaint;
  var chart = R("chart");
  var KlineChart = chart.KlineChart;
  var chart_panel = R("chart-panel");
  var SymbolSearch = chart_panel.SymbolSearch;
  var StockPanel = chart_panel.StockPanel;
  /**
   * 插件入口：槽位注册与生命周期
   *
   * 挂载点：
   *   shell.overlay      id stock-kline-ticker  价格挂件（主入口，进页面就可见）
   *   shell.overlay      id stock-kline-skin    对话页 K 线背景控制器
   *   main               key stock-kline        行情主面板大图
   *   sidebar.panellist  id stock-kline         侧边栏图标（部分构建不渲染，备用）
   *   settings.general.item ×2                  挂件开关 + K 线背景开关
   *
   * 依赖注入：React 的 h + useStore + 各模块导出（见 scripts/build.mjs 的 MODULES 表）。
   */

  var PANEL_ID = 'stock-kline';

  function icon(children, props) {
    var size = (props && props.size) || 16;
    return h(
      'svg',
      {
        className: 'dsk-icon',
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      children,
    );
  }

  function IconCandles(props) {
    return icon(
      [
        h('path', { key: 'w1', d: 'M3.5 2.2v11.6' }),
        h('rect', { key: 'b1', x: 2, y: 5.2, width: 3, height: 5.4, rx: 0.6 }),
        h('path', { key: 'w2', d: 'M8 1.2v13.6' }),
        h('rect', { key: 'b2', x: 6.5, y: 3.6, width: 3, height: 7, rx: 0.6 }),
        h('path', { key: 'w3', d: 'M12.5 3.6v9' }),
        h('rect', { key: 'b3', x: 11, y: 6, width: 3, height: 4.4, rx: 0.6 }),
      ],
      props,
    );
  }

  function SymbolEntry(props) {
    var pair = useState('');
    var text = pair[0];
    var setText = pair[1];
    return h('input', {
      className: 'dsk-input',
      style: { width: '86px', padding: '2px 6px', fontSize: '11px' },
      value: text,
      placeholder: props.current,
      title: '输入代码或名称后回车（如 600519 / 贵州茅台）',
      onChange: function (event) {
        setText(event.target.value);
      },
      onKeyDown: function (event) {
        if (event.key === 'Enter') {
          var value = text.trim();
          if (value !== '') {
            props.onPick(value);
            setText('');
          }
        }
        if (event.key === 'Escape') setText('');
      },
    });
  }

  function PanelIcon(props) {
    return h(IconCandles, { size: props && props.size ? props.size : 16 });
  }

  var TICKER_ID = 'stock-kline-ticker';
  /** 背景皮肤控制器的槽位 id（它自己返回 null，只借槽位拿 usePanelInfo）。 */
  var SKIN_ID = 'stock-kline-skin';

  /**
   * 设置页「通用」里的背景 K 线开关
   *
   * ## 为什么这里**只留背景 K 线**，不放浮窗开关
   *
   * 浮窗开关已经移到「行情 K 线」面板上。原因：浮窗的 × 一关就再也叫不回来，
   * 而浮窗是覆盖在别处的浮层 —— 用户没法从浮窗回到面板，所以**回程入口应当
   * 和浮窗所服务的那个东西放在一起**（面板），而不是藏在齿轮里。
   *
   * ## 这个开关管什么、不管什么
   *
   *   · 管：对话页要不要铺 K 线背景；
   *   · **不管取数** —— 数据获取只跟随"当前代码 + 周期"，与任何显示开关无关。
   *     关掉背景只是不画，不会停掉行情请求。
   */
  function SkinToggle(props) {
    var state = useStore(props.store);
    var on = state.skinOpen === true;
    return h(
      'label',
      { className: 'dsk-switch' },
      h('input', {
        type: 'checkbox',
        checked: on,
        onChange: function () {
          props.store.setSkinOpen(!on);
        },
      }),
      h('span', {}, '对话页显示 K 线背景（只影响显示，不影响取数）'),
    );
  }

  var store = createStore();

  function apply(ctx) {
    installCss();

    // 打开行情主面板：selectPanel 只认已注册的 main 键；不可用就静默忽略
    var openMain = function () {
      try {
        ctx.layout.selectPanel(PANEL_ID);
      } catch (error) {
        console.warn('[dsh-stock-kline] 打开主面板失败：' + (error instanceof Error ? error.message : String(error)));
      }
    };

    // 主面板大图（需要侧边栏图标才能点开；图标不渲染时它只是备用）
    ctx.slots.inject('main', function* () {
      yield ctx.slots.register({ name: 'main', key: PANEL_ID }, function () {
        return h(StockPanel, { store: store });
      });
    });

    // 侧边栏图标（某些构建里这排图标不渲染，所以只当备用入口）
    ctx.slots.inject('sidebar.panellist', function* () {
      yield ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => '行情 K 线' },
        PanelIcon,
      );
    });

    // 浮层：价格挂件 + 背景皮肤控制器（都不挡对话）
    ctx.slots.inject('shell.overlay', function* () {
      yield ctx.slots.register({ name: 'shell.overlay', id: TICKER_ID, order: 800 }, function (slotProps) {
        return h(PriceTicker, Object.assign({}, slotProps, { store: store, openMain: openMain }));
      });
      // 皮肤控制器自己返回 null，只是借这个槽位拿到 usePanelInfo 钩子；
      // K 线本体由它注入到对话页面容器里面的 DOM 层。
      yield ctx.slots.register({ name: 'shell.overlay', id: SKIN_ID, order: 810 }, function (slotProps) {
        return h(SkinController, Object.assign({}, slotProps, { store: store }));
      });
    });

    // 设置页「通用」里只剩背景 K 线开关。
    // 浮窗开关已移到「行情 K 线」面板（见 chart-panel.js 的 tickerToggle）——
    // 浮窗关掉后就没法从浮窗回到面板，所以回程入口要和浮窗所服务的面板在一起。
    ctx.slots.inject('settings.general.item', function* () {
      yield ctx.slots.register(
        { name: 'settings.general.item', id: 'stock-kline-skin', order: 61, label: () => 'K 线背景皮肤' },
        function () {
          return h(SkinToggle, { store: store });
        },
      );
    });

    // 插件加载时水合一次偏好（并写回宿主），之后交给用户操作。
    // 放在这里而不是组件里：组件每次渲染都水合会让迟到的宿主回填
    // 反复覆盖用户刚点的开关（host 预取与用户点击是竞态）。
    ctx.effect(function () {
      store.hydrate();
      return function () {
        /* 只负责水合，定时器由下面那个 effect 管 */
      };
    }, 'dsh-stock-kline: preferences');

    /**
     * 自动刷新：间隔**跟随当前周期**（分时 5s … 日/周/月 60s，见 market.js 的
     * `REFRESH_MS_BY_PERIOD`）。
     *
     * 为什么挂在插件这一层，而不是面板组件的 effect 里：**浮窗和对话背景 K 线
     * 在对话页就能看到**。若只在面板挂载时才启动定时器，用户一离开行情面板，
     * 那两处的价格与涨跌幅就冻在最后一次取数上了。
     *
     * 页面切到后台时定时器照常排，但回调直接返回不取数；回到前台立刻补一次，
     * 免得用户看到一屏过期数字。
     */
    ctx.effect(function () {
      store.startAutoRefresh();
      var onVisibilityChange = function () {
        if (typeof document === 'undefined') return;
        if (document.visibilityState === 'hidden') return;
        store.refresh();
      };
      var doc = typeof document === 'undefined' ? null : document;
      if (doc !== null) doc.addEventListener('visibilitychange', onVisibilityChange);
      return function () {
        store.stopAutoRefresh();
        if (doc !== null) doc.removeEventListener('visibilitychange', onVisibilityChange);
      };
    }, 'dsh-stock-kline: auto refresh');
  }

  return {
    name: 'dsh-stock-kline',
    inject: ['slots', 'layout', 'locale'],
    apply: apply,
    // 测试接缝：样式表完整性没法在真实页面里自动验证，
    // 测试台用直接求值 cssText() 来断言。
    __test: {
      skin: applyPageSkin,
      skinSvg: renderSkinSvg,
      css: getCss,
      store: store,
      PriceTicker: PriceTicker,
      // 关闭按钮的点击链路没法从 PriceTicker 整体渲染出来验证（它依赖订阅的 store），
      // 所以直接暴露这个纯展示组件，让测试台能给足 props 单独驱动。
      TickerSvg: TickerSvg,
      KlineChart: KlineChart,
      // 搜索框的联想状态（loading/done、防抖、键盘高亮）是异步过程，
      // 主测试台观察不到，所以单独暴露给 test/search.test.mjs 驱动。
      SymbolSearch: SymbolSearch,
      // 缩放策略：纯函数，渲染测不到（测试台每次 render 都重置 hook 状态）。
      // 它们住在 format 模块（主面板与对话背景共用一份），这里只是转出来给测试用。
      clampVisibleBars: clampVisibleBars,
      zoomStepsToCount: zoomStepsToCount,
      MAX_VISIBLE_BARS: MAX_VISIBLE_BARS,
      MIN_VISIBLE_BARS: MIN_VISIBLE_BARS,
      ZOOM_STEP: ZOOM_STEP,
      // 自动刷新间隔表（按周期分档），给 test/live-update.test.mjs 断言
      REFRESH_MS_BY_PERIOD: REFRESH_MS_BY_PERIOD,
      refreshIntervalFor: refreshIntervalFor,
    },
  };
    };

    // ===================== 启动 =====================
    var plugin = R('plugin');
    return { apply: plugin.apply, inject: plugin.inject, name: plugin.name, __test: plugin.__test };
  },
});
