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
    // 周期与标的的匹配（美股指数只有日/周/月），给 render 测试断言置灰逻辑
    periodsForCode: periodsForCode,
  },
};
