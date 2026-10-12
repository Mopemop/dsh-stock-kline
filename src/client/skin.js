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
