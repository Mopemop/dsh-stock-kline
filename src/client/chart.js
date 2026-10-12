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
