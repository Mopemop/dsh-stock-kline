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
