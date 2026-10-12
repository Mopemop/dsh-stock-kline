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

  /**
   * 当前标的支持哪些周期。
   *
   * 只有**美股指数**受限（腾讯对它们只提供日/周/月 K）—— 所以那四个分钟按钮
   * 要置灰。不置灰的话用户点了只会看到"该周期没有数据"，而且看不出为什么。
   */
  var allowedPeriods = periodsForCode(state.symbol);

  var toolbarRow = h('div', { className: 'dsk-toolbar', key: 'toolbar' }, [
    h(
      'div',
      { className: 'dsk-tabs', key: 'periods' },
      PERIOD_ROWS.map(function (row) {
        var supported = allowedPeriods === null || allowedPeriods.indexOf(row.id) >= 0;
        return h(
          'button',
          {
            key: row.id,
            type: 'button',
            className: 'dsk-tab',
            'data-on': state.period === row.id ? '1' : '0',
            disabled: supported ? undefined : true,
            title: supported ? undefined : '该标的没有这个周期的数据（腾讯只提供日/周/月 K）',
            onClick: function () {
              if (!supported) return;
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
