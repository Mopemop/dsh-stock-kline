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
