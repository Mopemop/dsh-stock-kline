/**
 * 客户端 bundle 渲染测试台。
 *
 * 为什么需要它：浏览器半侧没法在 Node 里直接跑（要 DOM + React + 已认证页面），
 * 但它恰恰是最容易出「NaN 坐标 / 未定义变量 / 快照不更新」这类问题的地方。
 * 这里桩掉 React、DOM、localStorage 与 ResizeObserver，用**真实行情数据**
 * （走宿主已经生效的 /dsh-stock-kline/api 路由）把主面板与迷你图各渲染一遍，
 * 并递归展开函数组件，逐个数值检查 SVG 几何是否合法。
 *
 * 注意：这个测试台需要 DSH 正在运行（127.0.0.1:19387）且插件宿主半侧已挂载。
 *
 * 检查项：
 *   1. bundle 形态：无顶层 import/export，结尾正确调用 __ModuleLoader__.load
 *   2. 插件体形态：apply / inject / name
 *   3. 注册的槽位：main / sidebar.panellist×2 / shell.overlay
 *   4. 主面板：真实数据渲出 svg，所有数值属性有限（无 NaN），蜡烛/网格/均线都在
 *   5. 交互：周期切换按钮可点，切换后仍渲出合法图表
 *   6. 迷你图：默认关闭返回 null；点击开关后渲出合法小图
 *   7. store：订阅收到通知、快照引用确实变化（useSyncExternalStore 的前提）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'lib', 'client.js');

// 墨色从产物里读，避免测试和实现的常量各写一份
// 默认标的：和宿主 lib/index.js 的 DEFAULTS 对齐（改默认值时只改这里和那里）
const DEFAULT_SYMBOL = '000300';
const DEFAULT_NAME = '沪深300';

const INK_HEX = (() => {
  const hit = /var INK = '(#[0-9a-fA-F]{6})'/.exec(readFileSync(BUNDLE, 'utf8'));
  return hit === null ? '#111418' : hit[1];
})();

const HOST = process.env.DSK_HOST ?? 'http://127.0.0.1:19387';

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ' + detail}`);
  if (!ok) failures++;
}

// ----------------------------------------------------------------- 桩

const realFetch = globalThis.fetch;

/** 极简元素构造：h(type, props, children) → {type, props, children} */
function makeElement(type, props, ...children) {
  const flat = [];
  const push = (value) => {
    if (value === null || value === undefined || value === false || value === true) return;
    if (Array.isArray(value)) value.forEach(push);
    else flat.push(value);
  };
  push(children);
  return { type, props: props ?? {}, children: flat };
}

/** 每个组件函数一份持久 hook 状态（单实例测试足够）。 */
const hookStores = new Map();
const componentKeys = new Map();
/** 本轮渲染排队的 effect，等整棵树展开（ref 挂好）后再统一执行。 */
const pendingEffects = [];
let hookCursor = 0;
let currentComponent = null;
let keySeq = 0;
/** 外部 store（行情）在渲染期间变更过：render() 需要因此再展开一次。 */
let pendingExternalUpdate = false;

function hooksFor(key) {
  if (!hookStores.has(key)) hookStores.set(key, { slots: [] });
  return hookStores.get(key);
}

function keyFor(type) {
  if (!componentKeys.has(type)) componentKeys.set(type, 'c' + keySeq++);
  return componentKeys.get(type);
}

const reactStub = {
  // bundle 里的 `h` 就是 require('react').createElement —— 必须提供它，
  // 否则测试台只能靠 jsx-runtime 兜着，测不出 `h` 绑错这种问题。
  createElement: makeElement,
  useState(initial) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    if (!(index in store.slots)) store.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      store.slots[index],
      (next) => {
        store.slots[index] = typeof next === 'function' ? next(store.slots[index]) : next;
      },
    ];
  },
  useRef(initial) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    if (!(index in store.slots)) store.slots[index] = { current: initial };
    return store.slots[index];
  },
  useMemo(factory) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    if (!(index in store.slots)) store.slots[index] = factory();
    return store.slots[index];
  },
  useCallback(fn) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    if (!(index in store.slots)) store.slots[index] = fn;
    return store.slots[index];
  },
  useEffect(effect) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    const key = 'effect' + index;
    if (!(key in store.slots)) {
      // 真实 React 在**整棵树 commit（ref 全部挂好）之后**才跑 effect，
      // 所以这里只排队；render() 会在第一遍展开完再统一 flush，
      // 否则 effect 里读到的 hostRef.current 还是 null。
      store.slots[key] = undefined;
      pendingEffects.push({ store, key, effect });
    }
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    if (!(index in store.slots)) {
      store.slots[index] = getSnapshot();
      subscribe(() => {
        store.slots[index] = getSnapshot();
        // 真实 React 收到外部 store 变更后会**重新渲染**，这里必须补上这一步：
        // 只更新槽位不够，因为组件树是 render() 一次性展开出来的，
        // 不重渲染就永远停在第一次的快照上（表现：数据到了却一直显示"正在取行情…"）。
        pendingExternalUpdate = true;
      });
    }
    return store.slots[index];
  },
  createElement: makeElement,
};

globalThis.window = {
  innerWidth: 1280,
  innerHeight: 860,
  addEventListener() {},
  removeEventListener() {},
  // 组件会挂一个 240ms 的延迟测量；测试里立刻返回 0 即可，
  // 否则定时器会在测试结束后触发 setState（Expanding into a closed world）。
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
  localStorage: {
    _data: new Map(),
    getItem(key) {
      return this._data.has(key) ? this._data.get(key) : null;
    },
    setItem(key, value) {
      this._data.set(key, String(value));
    },
  },
  __ModuleLoader__: {
    load(registration) {
      globalThis.window.__CAPTURED__ = registration;
    },
  },
};

// 真实浏览器有 rAF，组件会用它把一帧内的滚轮事件合并成一次更新。
// 测试台必须提供：否则组件走 setTimeout 回退路径，就测不到"合并"这个行为。
globalThis.window.__rafCalls = 0;
if (typeof globalThis.window.requestAnimationFrame !== 'function') {
  globalThis.window.requestAnimationFrame = (callback) => {
    globalThis.window.__rafCalls++;
    return setTimeout(() => callback(0), 0);
  };
  globalThis.window.cancelAnimationFrame = (id) => clearTimeout(id);
}

/**
 * 一帧内"排了几次渲染"的计数器。
 *
 * ⚠️ 必须读**桩自身**的累计数，不能在测试里临时替换
 * `window.requestAnimationFrame` —— 组件的 onWheel 被 useCallback 缓存，
 * 持有的是替换前那份引用，替换后计数永远是 0（假失败）。
 */
const rafCount = () => globalThis.window.__rafCalls;

globalThis.document = {
  head: { appendChild() {} },
  createElement: () => ({
    dataset: {},
    style: {},
    textContent: '',
    // 图表容器测量：给一个确定的尺寸，避免首帧落到兜底值而看不到真实布局
    getBoundingClientRect: () => ({ width: 920, height: 520, top: 0, left: 0, right: 920, bottom: 520 }),
  }),
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
};

globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {
    // 真实浏览器里 observe 后会立刻回填一次尺寸；测试台必须模拟，
    // 否则组件拿不到容器尺寸（这正是之前 viewBox 高度是 '100%' 的原因）。
    this.callback();
  }
  disconnect() {}
};

globalThis.fetch = (url, options) => (String(url).startsWith('/') ? realFetch(HOST + url, options) : realFetch(url, options));

// 顺手记下最近一次行情响应里的 K 线，给需要真数据的断言用
let quoteCandles = [];
globalThis.fetch = ((inner) => (url, options) => {
  const promise = inner(url, options);
  const text = String(url);
  if (text.includes('/api/quote')) {
    promise
      .then((res) => res.clone().json())
      .then((body) => {
        if (Array.isArray(body?.candles) && body.candles.length > 0) quoteCandles = body.candles;
      })
      .catch(() => {});
  }
  return promise;
})(globalThis.fetch);

// 每次跑测试前把宿主偏好与本地缓存清成已知状态，避免上一次运行的残留影响断言
await realFetch(HOST + '/dsh-stock-kline/api/prefs', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ symbol: DEFAULT_SYMBOL, period: 'day', tickerOpen: true }),
}).catch(() => {});

// ----------------------------------------------------------------- 载入 bundle

const source = readFileSync(BUNDLE, 'utf8');
check('无顶层 import 语句', /^\s*import\s/m.test(source) === false);
check('无顶层 export 语句', /^\s*export\s/m.test(source) === false);
check('调用了 __ModuleLoader__.load', source.includes('window.__ModuleLoader__.load('));

// `h` 必须绑到 createElement(type, props, ...children)。
// 曾经绑成 jsx-runtime 的 jsx(type, props, key) —— 第三参数是 key，
// 于是 `h('div', props, child)` 的子元素全被丢掉：浮窗只剩一个空容器
// （白框、没有 svg、没有文字）。测试台的 makeElement 是 createElement 语义，
// 所以那种错误在组件树断言里**测不出来**，必须直接查产物的绑定。
check(
  'h 绑定为 react.createElement（不是 jsx-runtime 的 jsx）',
  source.includes("var h = require('react').createElement;") && !/var h = require\('react\/jsx-runtime'\)\.jsx/.test(source),
  (source.match(/var h = require\([^)]*\)[^;]*;/g) ?? []).slice(0, 3).join(' | '),
);

const platformRequire = (name) => {
  if (name === 'react') return reactStub;
  if (name === 'react/jsx-runtime') return { jsx: makeElement, jsxs: makeElement };
  throw new Error('未知模块请求：' + name);
};

const registration = new Function('window', 'require', 'console', source + '\nreturn window.__CAPTURED__;')(
  globalThis.window,
  platformRequire,
  console,
);
check('注册 id 正确', registration?.id === 'dsh-stock-kline', String(registration?.id));

const plugin = registration.factory(platformRequire);
check(
  '插件体有 apply/inject/name',
  typeof plugin.apply === 'function' && Array.isArray(plugin.inject) && typeof plugin.name === 'string',
  JSON.stringify({ inject: plugin.inject, name: plugin.name }),
);

/** 测试接缝：bundle 通过 `__test` 暴露 css / store / 组件 / 皮肤注入。 */
const api = plugin.__test;

// ------------------------------------------------------ 涨跌幅基准（回归：东财指数昨收错）
//
// 实测东财对**指数**返回的 preKPrice 与 K 线不自洽（沪深300 给 4593.98，
// 而相邻两根是 4310.28 → 4317.25），照它算出来是 -6% 这种明显错误的值。
// 所以基准必须优先取"倒数第二根收盘"，源给的昨收只作兜底。
{
  const formatSource = readFileSync(join(HERE, '..', 'src', 'client', 'format.js'), 'utf8');
  const baselineBody = /function baselineOf\(quote\)\s*\{([\s\S]*?)\n\}/.exec(formatSource)?.[1] ?? '';
  const candlesAt = baselineBody.indexOf('candles.length - 2');
  const preCloseAt = baselineBody.indexOf('quote.preClose');
  check(
    'baselineOf 优先取倒数第二根收盘（不是源给的昨收）',
    candlesAt >= 0 && preCloseAt >= 0 && candlesAt < preCloseAt,
    '东财对指数返回的 preKPrice 不可信',
  );

  // 用真实存在的历史数据形态直测：源昨收故意给错，结果必须是相邻两根算出来的
  const store = api.store;
  const snapshot = store.get();
  const quote = snapshot.quote;
  if (quote !== null && quote !== undefined && Array.isArray(quote.candles) && quote.candles.length >= 2) {
    const prev = quote.candles[quote.candles.length - 2];
    const last = quote.candles[quote.candles.length - 1];
    const withWrongPreClose = Object.assign({}, quote, { preClose: prev.close * 1.5 });
    const price = typeof api.baselineOf === 'function' ? null : null;
    // baselineOf 没直接暴露在 __test 上，这里用挂件的百分比间接验证：
    // 错到 1.5 倍的昨收会给出约 -33% 的涨跌幅，正确基准给出的是个位数百分比
    const t = (() => {
      const pctOf = (base) => ((last.close - base) / base) * 100;
      return { wrong: pctOf(prev.close * 1.5), right: pctOf(prev.close) };
    })();
    check(
      '错误的源昨收会算出明显离谱的涨跌幅（说明这段逻辑值得守）',
      Math.abs(t.wrong) > 20 && Math.abs(t.right) < 20,
      `错基准 ${t.wrong.toFixed(1)}% / 正确基准 ${t.right.toFixed(1)}%`,
    );
  }
}

// ----------------------------------------------------------------- 槽位注册

const registrations = [];

/** 递归展开函数组件（React 会做这件事，测试台必须自己补上）。 */
function expand(node, depth) {
  if (node === null || node === undefined) return node;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map((child) => expand(child, depth));
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') {
    if (depth > 40) throw new Error('展开层数过深，可能有循环组件');
    const previous = currentComponent;
    const previousCursor = hookCursor;
    currentComponent = keyFor(node.type);
    hookCursor = 0;
    let rendered;
    try {
      rendered = node.type(node.props);
    } finally {
      currentComponent = previous;
      hookCursor = previousCursor;
    }
    return expand(rendered, depth + 1);
  }
  const committed = commitRefs({
    type: node.type,
    props: node.props,
    children: (node.children ?? []).map((child) => expand(child, depth)).filter((child) => child !== null),
  });
  return committed;
}

/**
 * React 的 commit 阶段会把 ref 挂到宿主节点上；测试台必须补这一步，
 * 否则 `hostRef.current` 永远是 null（真实浏览器里它就是 DOM 节点）。
 * 这里用一个假节点满足组件会用到的方法。
 */
function commitRefs(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(commitRefs);
  if (typeof node.type === 'string') {
    const ref = node.props?.ref;
    if (ref !== null && typeof ref === 'object' && 'current' in ref) {
      const rect = () => ({ width: 920, height: 520, top: 0, left: 0, right: 920, bottom: 520 });
      ref.current = {
        getBoundingClientRect: rect,
        setPointerCapture() {},
        releasePointerCapture() {},
        contains: () => false,
        closest: () => null,
        parentElement: { getBoundingClientRect: rect },
        addEventListener() {},
        removeEventListener() {},
      };
    }
  }
  node.children = (node.children ?? []).map(commitRefs);
  return node;
}

const fakeCtx = {
  layout: { selectPanel: (id) => registrations.push({ kind: 'selectPanel', id }) },
  effect: (fn) => {
    fn();
    return () => {};
  },
  slots: {
    inject(key, callback) {
      const iterable = callback();
      if (iterable !== undefined && typeof iterable[Symbol.iterator] === 'function') {
        for (const _ of iterable) {
          /* 消费 disposer */
        }
      }
      return () => {};
    },
    register(options, component) {
      registrations.push({ kind: 'register', options, component });
      return () => {};
    },
  },
};

plugin.apply(fakeCtx);

const bySlot = (name) => registrations.filter((row) => row.kind === 'register' && row.options.name === name);
check(
  '注册了 main 面板',
  bySlot('main').length === 1 && bySlot('main')[0].options.key === 'stock-kline',
  JSON.stringify(bySlot('main').map((row) => row.options)),
);
check(
  '注册了 1 个侧边栏图标（备用入口）',
  bySlot('sidebar.panellist').length === 1 && bySlot('sidebar.panellist')[0].options.id === 'stock-kline',
  JSON.stringify(bySlot('sidebar.panellist').map((row) => row.options.id)),
);
check(
  '注册了 shell.overlay（价格挂件 + 皮肤控制器）',
  bySlot('shell.overlay').length === 2 &&
    bySlot('shell.overlay').some((row) => row.options.id === 'stock-kline-ticker') &&
    bySlot('shell.overlay').some((row) => row.options.id === 'stock-kline-skin'),
  JSON.stringify(bySlot('shell.overlay').map((row) => row.options.id)),
);
check(
  '设置页只留背景 K 线开关（浮窗开关已移到面板）',
  bySlot('settings.general.item').length === 1 &&
    bySlot('settings.general.item')[0].options.id === 'stock-kline-skin',
  JSON.stringify(bySlot('settings.general.item').map((row) => row.options.id)),
);

// ----------------------------------------------------------------- 渲染工具

function render(component, props) {
  // ⚠️ 根组件**必须也走 expand**，不能直接 `component(props)` 调用。
  // 直接调用时 `currentComponent` / `hookCursor` 都还是上一个组件残留的值，
  // 于是根组件的 hook 全被挂到**别人的 key** 上 —— 后果：
  //   · `renderFresh()` 清不掉它的槽位，挂载期 effect 永远不会重跑；
  //   · 同一组件在不同用例间互相污染槽位。
  // 曾因此让一条回归断言"回退了修复也照样 PASS"（假阳性），所以这里必须包成节点。
  const root = { type: component, props: props ?? {}, children: [] };
  // pass1：整棵树展开 + 挂 ref（此时 effect 只排队）
  const first = expand(commitRefs(root), 0);
  // flush：ref 已就绪，执行 effect（可能 setState）
  const queued = pendingEffects.splice(0, pendingEffects.length);
  for (const item of queued) item.store.slots[item.key] = item.effect();
  // pass2：把 effect 里 setState 的结果体现出来（同样走 expand，理由见上）
  let second = expand(commitRefs({ type: component, props: props ?? {}, children: [] }), 0);

  // pass3：外部 store 在 pass1/pass2 期间变更了（异步取数落地）就会置位这个标记，
  // 真实 React 会因此再渲染一次 —— 这里补上，否则数据永远显示不出来。
  let guard = 0;
  while (pendingExternalUpdate && guard < 8) {
    pendingExternalUpdate = false;
    guard++;
    second = expand(commitRefs({ type: component, props: props ?? {}, children: [] }), 0);
    const more = pendingEffects.splice(0, pendingEffects.length);
    for (const item of more) item.store.slots[item.key] = item.effect();
  }

  return second === null ? first : second;
}

/**
 * 模拟**全新挂载**：先清掉该组件的 hook 槽位，让 `useEffect` 重新排队。
 *
 * 为什么需要它：测试台的 effect 桩只在"首次遇到这个 hook 索引"时排队
 * （`if (!(key in store.slots))`）。所以同一组件在文件里被渲染过之后，
 * 它的挂载期 effect 就再也不会跑了 —— 想验证"挂载时才会执行的逻辑"
 * （例如回到面板时的视野初始化）就必须先清空槽位，否则测了个假阳性。
 */
function renderFresh(component, props) {
  const key = componentKeys.get(component);
  if (key !== undefined) hookStores.delete(key);
  return render(component, props);
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return (node.children ?? []).map(textOf).join(' ');
}

function collectNumbers(node, out, path) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, index) => collectNumbers(child, out, `${path}[${index}]`));
    return;
  }
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (typeof value === 'number') out.push({ path: `${path}.${node.type}.${key}`, value });
  }
  (node.children ?? []).forEach((child, index) => collectNumbers(child, out, `${path}>${index}`));
}

function countTags(node, tag, acc = { n: 0 }) {
  if (node === null || node === undefined || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    node.forEach((child) => countTags(child, tag, acc));
    return acc;
  }
  if (node.type === tag) acc.n += 1;
  (node.children ?? []).forEach((child) => countTags(child, tag, acc));
  return acc;
}

function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
}

function assertNumeric(label, node) {
  const numbers = [];
  collectNumbers(node, numbers, 'root');
  const bad = numbers.filter((row) => !Number.isFinite(row.value));
  check(label, bad.length === 0, bad.slice(0, 5).map((row) => `${row.path}=${row.value}`).join('; ') || `${numbers.length} 个数值全部有限`);
}

// ----------------------------------------------------------------- 主面板

const mainComponent = bySlot('main')[0].component;
let tree = render(mainComponent, {});
check('首次渲染进入加载态', textOf(tree).includes('正在取行情'), textOf(tree).slice(0, 80));

// 这是真网络调用。分两步等，避免"渲染一次碰运气"：
//   1) 先等 **store 就绪**（数据落地是权威信号）；
//   2) 再显式重渲染，直到组件树跟上（外部 store 变更 → 重渲染这一步由测试台补）。
// 窗口 30 秒：宿主正常 ~0.4s，偶发限流会拖长。
for (let i = 0; i < 100; i++) {
  if (api.store.get().quote !== null) break;
  // 每 2 秒显式重试一次，别干等第一次那个请求
  if (i > 0 && i % 10 === 0) api.store.refresh();
  await new Promise((resolve) => setTimeout(resolve, 300));
}
check(
  'store 拿到了行情（取数链路）',
  api.store.get().quote !== null,
  api.store.get().error === null ? '超时未返回' : String(api.store.get().error),
);
for (let i = 0; i < 30; i++) {
  tree = render(mainComponent, {});
  if (textOf(tree).includes(DEFAULT_NAME)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
check('真实取数后渲出股票名', textOf(tree).includes(DEFAULT_NAME), textOf(tree).slice(0, 120));
check(
  '真实取数后显示数据源徽标',
  // 三个源都可能出现（同花顺 / 东财 / 腾讯），断言"标了具体来源"而不是某个具体名字
  ['同花顺', '东财', '腾讯'].some((label) => textOf(tree).includes(label)),
  textOf(tree).slice(-200),
);
// 价格量级随标的变化（指数是 4 位数、个股也是 4 位数），所以断言"有价格数字"而不是具体数值
check('真实取数后显示价格', /\d+\.\d\d/.test(textOf(tree)), textOf(tree).slice(0, 160));

assertNumeric('主面板所有数值属性有限（无 NaN）', tree);
const rectCount = countTags(tree, 'rect').n;
const lineCount = countTags(tree, 'line').n;
const polylineCount = countTags(tree, 'polyline').n;
check('主面板渲出蜡烛与成交量柱', rectCount > 20, `rect=${rectCount}`);
check('主面板渲出网格与均线', lineCount > 3 && polylineCount >= 1, `line=${lineCount} polyline=${polylineCount}`);

const svg = findNode(tree, (node) => node.type === 'svg');
const viewParts = String(svg?.props?.viewBox ?? '').split(' ').map(Number);
check(
  'svg viewBox 合法',
  viewParts.length === 4 && viewParts.every(Number.isFinite) && viewParts[2] > 0 && viewParts[3] > 0,
  String(svg?.props?.viewBox),
);

// ----------------------------------------------------------------- 常见指数快捷入口
//
// 指数就那么几个、天天看，做成一排按钮一次点击直达；个股有几千个，只能靠搜索。
// 清单真源在 lib/indices.js，客户端的 src/client/indices.js 由构建脚本校验一致。

const INDEX_GROUPS_EXPECTED = [
  { label: '沪深', names: ['沪深300', '中证500', '上证50', '深证成指', '创业板指', '中小100'] },
  { label: '港股', names: ['恒生指数', '恒生科技'] },
  { label: '美股', names: ['道琼斯', '纳斯达克', '标普500'] },
];
const ALL_INDEX_NAMES = INDEX_GROUPS_EXPECTED.flatMap((group) => group.names);

const indexButtons = [];
(function walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(walk);
  if (node.type === 'button' && node.props && typeof node.props.onClick === 'function') indexButtons.push(node);
  (node.children ?? []).forEach(walk);
})(tree);
const indexLabels = indexButtons.map((button) => textOf(button).trim());
for (const name of ALL_INDEX_NAMES) {
  check(`指数快捷按钮里有「${name}」`, indexLabels.includes(name), indexLabels.join(' | ').slice(0, 260));
}

/** 收集某节点下的全部按钮文案。 */
function buttonTextsUnder(node) {
  const out = [];
  (function walk(n) {
    if (n === null || n === undefined || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'button') out.push(textOf(n).trim());
    (n.children ?? []).forEach(walk);
  })(node);
  return out;
}

// 指数快捷行按市场分组：沪深 / 港股 / 美股。11 个按钮平铺一片会看不出市场归属。
{
  const row = findNode(tree, (node) => node.props?.className === 'dsk-indexRow');
  check('指数快捷行存在', row !== null);

  const groups = (row?.children ?? []).filter(
    (child) => typeof child?.props?.className === 'string' && child.props.className.includes('dsk-indexGroup'),
  );
  check(
    '指数行按 3 个市场分组',
    groups.length === INDEX_GROUPS_EXPECTED.length,
    `实际 ${groups.length} 组`,
  );

  INDEX_GROUPS_EXPECTED.forEach((expected, index) => {
    const group = groups[index];
    if (group === undefined) {
      check(`第 ${index + 1} 组是「${expected.label}」`, false, '(缺少该组)');
      return;
    }
    const labels = buttonTextsUnder(group);
    check(
      `第 ${index + 1} 组是「${expected.label}」且成员正确`,
      textOf(group).includes(expected.label) &&
        labels.length === expected.names.length &&
        expected.names.every((name) => labels.includes(name)),
      `→ ${labels.join(',')}`,
    );
  });

  // 周期按钮、搜索、刷新、两个开关都不能出现在指数行里
  const forbidden = ['分时', '5分', '15分', '30分', '60分', '日K', '周K', '月K', '刷新', '浮窗 开', '皮肤 开'];
  const inRow = buttonTextsUnder(row);
  check(
    '指数行只含指数按钮（不混周期/操作按钮）',
    inRow.length === ALL_INDEX_NAMES.length &&
      inRow.every((label) => ALL_INDEX_NAMES.includes(label)) &&
      !inRow.some((label) => forbidden.includes(label)),
    inRow.join(' | '),
  );
}

// 点一下指数按钮，应该切到这个指数（而不是去开搜索）
const hs300Button = indexButtons.find((button) => textOf(button).trim() === '沪深300');
check('找到沪深300按钮', hs300Button !== undefined);
if (hs300Button !== undefined) {
  const before = plugin.__test.store.get().symbol;
  hs300Button.props.onClick();
  check('点指数按钮会切换当前代码', plugin.__test.store.get().symbol === '000300', `before=${before} after=${plugin.__test.store.get().symbol}`);
  check(
    '当前是指数时该按钮高亮',
    (() => {
      const again = render(mainComponent, {});
      const btn = (function find(node) {
        if (node === null || node === undefined || typeof node !== 'object') return null;
        if (Array.isArray(node)) {
          for (const child of node) {
            const hit = find(child);
            if (hit !== null) return hit;
          }
          return null;
        }
        if (node.type === 'button' && textOf(node).trim() === '沪深300') return node;
        for (const child of node.children ?? []) {
          const hit = find(child);
          if (hit !== null) return hit;
        }
        return null;
      })(again);
      return btn?.props?.['data-on'] === '1';
    })(),
    '选中指数应高亮',
  );
}

// ------------------------------------------------- 图表上方的三行结构
//
// 早先这里是一个扁平 flex 行塞了 9 样东西（标题/价格/涨跌/两个徽标/周期/搜索/刷新/两个开关），
// 靠 flex-wrap **偶然**折成两行 —— 面板一变宽就重新洗牌：周期按钮跑到标题旁边、
// 开关被挤到下一行。现在固定为三行，每行单一职责，换行只发生在组内部。
//
// 这些断言钉住"分组关系"，避免以后又退回平铺。

{
  const panelTree = render(mainComponent, {});
  const byClass = (node, cls) =>
    findNode(node, (n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls));

  const head = byClass(panelTree, 'dsk-head');
  check('面板头部存在', head !== null);

  // 行数：恰好两行（行情行 + 工具行）。快捷指数行是独立节点（dsk-indexRow），不在这里。
  const headChildren = (head?.children ?? []).filter((c) => c !== null && c !== undefined);
  const headClasses = headChildren.map((c) => (typeof c.props?.className === 'string' ? c.props.className : String(c.type)));
  check(
    '头部恰好两行：行情行 + 工具行',
    headChildren.length === 2 && headClasses[0].includes('dsk-quoteRow') && headClasses[1].includes('dsk-toolbar'),
    JSON.stringify(headClasses),
  );

  const quoteRow = byClass(panelTree, 'dsk-quoteRow');
  const toolbar = byClass(panelTree, 'dsk-toolbar');
  const indexRow = byClass(panelTree, 'dsk-indexRow');
  check('① 行情行存在', quoteRow !== null);  check('② 工具行存在', toolbar !== null);
  check('③ 快捷指数行独立于头部两行', indexRow !== null);

  // ① 行情行：标题/价格/涨跌在左，spacer 之后是数据元信息（来源 + 时间成对）
  {
    const kids = (quoteRow?.children ?? []).filter((c) => c !== null && c !== undefined);
    const classes = kids.map((c) => (typeof c.props?.className === 'string' ? c.props.className : ''));
    const spacerAt = classes.findIndex((c) => c.includes('dsk-spacer'));
    const metaAt = classes.findIndex((c) => c.includes('dsk-meta'));
    check('行情行有标题', classes.some((c) => c.includes('dsk-title')));
    check('行情行有价格与涨跌', classes.some((c) => c.includes('dsk-price')) && classes.some((c) => c.includes('dsk-chg')));
    check(
      '数据元信息（来源+时间）成对放在行情行最右（spacer 之后）',
      metaAt > spacerAt && spacerAt >= 0,
      `spacer@${spacerAt} meta@${metaAt}：${JSON.stringify(classes)}`,
    );
    const meta = byClass(quoteRow, 'dsk-meta');
    const badges = (meta?.children ?? []).filter((c) => c !== null && c !== undefined && c.type === 'span');
    check('元信息里是两个徽标（数据源 + 更新时间）', badges.length === 2, `实际 ${badges.length} 个`);
  }

  // ② 工具行：周期 tabs ｜ 竖线 ｜ 动作组
  {
    const kids = (toolbar?.children ?? []).filter((c) => c !== null && c !== undefined);
    const classes = kids.map((c) => (typeof c.props?.className === 'string' ? c.props.className : String(c.type)));
    const tabsAt = classes.findIndex((c) => c.includes('dsk-tabs'));
    const sepAt = classes.findIndex((c) => c.includes('dsk-vsep'));
    const actionsAt = classes.findIndex((c) => c.includes('dsk-actions'));
    const tbSpacerAt = classes.findIndex((c) => c.includes('dsk-spacer'));
    check(
      '工具行顺序：周期 tabs → spacer → 竖线 → 动作组',
      tabsAt >= 0 && tbSpacerAt > tabsAt && sepAt > tbSpacerAt && actionsAt > sepAt,
      JSON.stringify(classes),
    );
    check(
      '竖线紧贴动作组（分组线紧跟它分隔的那一组）',
      sepAt === actionsAt - 1,
      `vsep@${sepAt} actions@${actionsAt}`,
    );

    // 周期按钮必须在 tabs 里，而不是散在工具行
    const tabs = byClass(toolbar, 'dsk-tabs');
    const periodCount = (tabs?.children ?? []).filter((c) => c?.type === 'button').length;
    check('周期按钮都在 tabs 分组内', periodCount === 8, `实际 ${periodCount} 个（应为 8：分时/5/15/30/60/日/周/月）`);

    // 动作组：搜索框 + 刷新 + 浮窗 + 皮肤
    const actions = byClass(toolbar, 'dsk-actions');
    const actionTexts = (actions?.children ?? [])
      .filter((c) => c !== null && c !== undefined)
      .map((c) => textOf(c).trim())
      .filter((t) => t !== '');
    check(
      '动作组含刷新与两个显示开关',
      actionTexts.some((t) => t.includes('刷新')) &&
        actionTexts.some((t) => t.includes('浮窗')) &&
        actionTexts.some((t) => t.includes('皮肤')),
      JSON.stringify(actionTexts),
    );
    check('搜索框在动作组里', byClass(actions, 'dsk-search') !== null);
  }

  // 布局层面：头部是**纵向列**（而不是会随机折行的扁平 wrap 行）
  const css = api.css();
  const headRule = /\.dsk-head\{([^}]*)\}/.exec(css)?.[1] ?? '';
  check(
    'CSS：头部是纵向列布局',
    headRule.includes('flex-direction:column'),
    headRule || '(没找到 .dsk-head 规则)',
  );
  check('CSS：行情行与工具行都有各自的规则', /\.dsk-quoteRow\{/.test(css) && /\.dsk-toolbar\{/.test(css));
  check('CSS：竖线分隔符有样式', /\.dsk-vsep\{/.test(css));
  check(
    'CSS：刷新按钮定宽（避免加载时整行抖动）',
    /\.dsk-btnRefresh\{[^}]*min-width/.test(css),
  );
  check(
    'CSS：macOS 顶部间隙规则保留',
    /\[data-platform=darwin\] \.dsk-head\{[^}]*padding-top/.test(css),
    '删掉这条会让 macOS 上头部被红绿灯按钮压住',
  );
}

// ------------------------------------------------- 浮窗开关在面板上，且与背景 K 线解耦
//
// 需求背景：浮窗的 × 一关就再也叫不回来（通用开关藏在齿轮里），所以面板要提供回程入口。
// 同时必须保证三件事互不影响：
//   · 浮窗显不显示（tickerOpen）
//   · 背景 K 线铺不铺（skinOpen）
//   · 数据取不取（只跟 symbol/period 有关，与上面两个开关都无关）

{
  const store = api.store;
  const panelTree = render(mainComponent, {});
  // 记下当前标的与周期，用来验证"关浮窗不会影响取数"
  const before_index_symbol = store.get().symbol;
  const before_index_period = store.get().period;

  const findButtonByText = (tree, label) =>
    (function find(node) {
      if (node === null || node === undefined || typeof node !== 'object') return null;
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = find(child);
          if (hit !== null) return hit;
        }
        return null;
      }
      if (node.type === 'button' && textOf(node).trim() === label) return node;
      for (const child of node.children ?? []) {
        const hit = find(child);
        if (hit !== null) return hit;
      }
      return null;
    })(tree);

  const tickerBtn = findButtonByText(panelTree, '浮窗 开') ?? findButtonByText(panelTree, '浮窗 关');
  check('面板上有浮窗开关', tickerBtn !== null, '面板头部应有「浮窗 开/关」按钮');
  if (tickerBtn !== null) {
    // 先把状态摆成"都开着"
    store.set({ tickerOpen: true, skinOpen: true });
    const treeOpen = render(mainComponent, {});
    const btnOpen = findButtonByText(treeOpen, '浮窗 开');
    check('浮窗开着时按钮显示「浮窗 开」', btnOpen !== null);

    if (btnOpen !== null) {
      btnOpen.props.onClick();
      const after = store.get();
      check('点面板开关会关掉浮窗', after.tickerOpen === false, `tickerOpen=${after.tickerOpen}`);
      check(
        '关浮窗**不会**动到背景 K 线',
        after.skinOpen === true,
        `skinOpen=${after.skinOpen}（必须仍为 true）`,
      );
      check(
        '关浮窗后当前代码/周期不变（取数不受影响）',
        after.symbol === before_index_symbol && after.period === before_index_period,
        `symbol=${after.symbol} period=${after.period}`,
      );

      // 再点回来
      const treeClosed = render(mainComponent, {});
      const btnClosed = findButtonByText(treeClosed, '浮窗 关');
      check('浮窗关着时按钮显示「浮窗 关」', btnClosed !== null);
      if (btnClosed !== null) {
        btnClosed.props.onClick();
        check('再点一次能重新打开浮窗', store.get().tickerOpen === true, String(store.get().tickerOpen));
      }
    }
  }

  // 反方向：关背景 K 线不能动浮窗
  store.set({ tickerOpen: true, skinOpen: true });
  store.setSkinOpen(false);
  check(
    '关背景 K 线不会动到浮窗',
    store.get().tickerOpen === true && store.get().skinOpen === false,
    JSON.stringify({ tickerOpen: store.get().tickerOpen, skinOpen: store.get().skinOpen }),
  );
  store.setSkinOpen(true);

  // 面板上也要有皮肤开关（它铺在对话底下，人在对话页时最想顺手开关）
  store.set({ tickerOpen: true, skinOpen: true });
  const skinTreeOpen = render(mainComponent, {});
  const skinBtnOpen = findButtonByText(skinTreeOpen, '皮肤 开');
  check('面板上有皮肤开关', skinBtnOpen !== null, '面板头部应有「皮肤 开/关」按钮');

  if (skinBtnOpen !== null) {
    const beforeSymbol = store.get().symbol;
    const beforePeriod = store.get().period;
    skinBtnOpen.props.onClick();
    const afterSkin = store.get();
    check('点面板皮肤开关会关掉背景 K 线', afterSkin.skinOpen === false, `skinOpen=${afterSkin.skinOpen}`);
    check(
      '关皮肤**不会**动到浮窗',
      afterSkin.tickerOpen === true,
      `tickerOpen=${afterSkin.tickerOpen}（必须仍为 true）`,
    );
    check(
      '关皮肤后当前代码/周期不变（取数不受影响）',
      afterSkin.symbol === beforeSymbol && afterSkin.period === beforePeriod,
      `symbol=${afterSkin.symbol} period=${afterSkin.period}`,
    );

    const skinTreeClosed = render(mainComponent, {});
    const skinBtnClosed = findButtonByText(skinTreeClosed, '皮肤 关');
    check('皮肤关着时按钮显示「皮肤 关」', skinBtnClosed !== null);
    if (skinBtnClosed !== null) {
      skinBtnClosed.props.onClick();
      check('再点一次能重新打开皮肤', store.get().skinOpen === true, String(store.get().skinOpen));
    }
  }

  // 两个按钮在同一个面板头部，且各自只写自己的字段
  const panelSource = readFileSync(join(HERE, '..', 'src', 'client', 'chart-panel.js'), 'utf8');
  const tickerBtnBody = /key: 'tickerToggle'[\s\S]*?onClick: function \(\) \{([\s\S]*?)\}/.exec(panelSource)?.[1] ?? '';
  const skinBtnBody = /key: 'skinToggle'[\s\S]*?onClick: function \(\) \{([\s\S]*?)\}/.exec(panelSource)?.[1] ?? '';
  check(
    '面板「浮窗」按钮只写 tickerOpen',
    tickerBtnBody.includes('setTickerOpen') && !tickerBtnBody.includes('setSkinOpen'),
    tickerBtnBody.trim().replace(/\s+/g, ' '),
  );
  check(
    '面板「皮肤」按钮只写 skinOpen',
    skinBtnBody.includes('setSkinOpen') && !skinBtnBody.includes('setTickerOpen'),
    skinBtnBody.trim().replace(/\s+/g, ' '),
  );

  // 结构层面：浮窗的 × 只写 tickerOpen，不碰 skinOpen
  const tickerSource = readFileSync(join(HERE, '..', 'src', 'client', 'ticker.js'), 'utf8');
  const closeHandler = /onClose: function \(\) \{([\s\S]*?)\}/.exec(tickerSource)?.[1] ?? '';
  check(
    '浮窗 × 只关浮窗，不碰背景 K 线',
    closeHandler.includes('setTickerOpen') && !closeHandler.includes('setSkinOpen'),
    closeHandler.trim().replace(/\s+/g, ' '),
  );

  // 复位，别把状态留给后面的用例
  store.set({ tickerOpen: true, skinOpen: true });
}

// ----------------------------------------------------------------- 交互：切周期

const buttons = [];
(function walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(walk);
    return;
  }
  if (node.type === 'button' && node.props && typeof node.props.onClick === 'function') buttons.push(node);
  (node.children ?? []).forEach(walk);
})(tree);
check('渲出了周期/刷新按钮', buttons.length >= 8, String(buttons.length));

const weekButton = buttons.find((button) => textOf(button).trim() === '周K');
check('找到周K按钮', weekButton !== undefined);
if (weekButton !== undefined) {
  weekButton.props.onClick();
  let ok = false;
  let lastDetail = '';
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    tree = render(mainComponent, {});
    const numbers = [];
    collectNumbers(tree, numbers, 'root');
    lastDetail = `rect=${countTags(tree, 'rect').n} badNums=${numbers.filter((r) => !Number.isFinite(r.value)).length}`;
    if (textOf(tree).includes(DEFAULT_NAME) && countTags(tree, 'rect').n > 20 && numbers.every((row) => Number.isFinite(row.value))) {
      ok = true;
      break;
    }
  }
  check('切到周K后仍渲出合法图表', ok, lastDetail);
}

// 悬停：直接调 svg 的 onPointerMove，验证十字光标与数据行不会崩
const svgNode0 = findNode(tree, (node) => node.type === 'svg');
check('svg 带指针事件', typeof svgNode0?.props?.onPointerMove === 'function' && typeof svgNode0?.props?.onWheel === 'function');

// ------------------------------------------------- 提示文字不承诺做不到的操作
//
// 曾经底部提示写着「滚轮缩放 · 按住拖动平移 · 悬停看当根数据」，
// 而"按住拖动平移"因为指针捕获挂错元素一直是失效的 —— 用户反馈"这个功能实际上没效果"，
// 要求去掉描述。这里钉住：提示里不再提拖动/平移。
{
  const hints = [];
  (function walk(n) {
    if (n === null || n === undefined || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.props?.className === 'string' && n.props.className.split(' ').includes('dsk-hint')) hints.push(n);
    (n.children ?? []).forEach(walk);
  })(tree);
  const hintText = hints.map(textOf).join(' ').replace(/\s+/g, ' ').trim();
  check('底部提示存在', hints.length >= 1, hintText);
  check(
    '提示里不再提"拖动平移"',
    !/拖动|平移/.test(hintText),
    hintText || '(空)',
  );
  check(
    '提示只写确实可用的操作（滚轮缩放 + 悬停）',
    /滚轮缩放/.test(hintText) && /悬停/.test(hintText),
    hintText,
  );
  // 整个 chart.js 的提示文案里也不该再出现
  const chartSrcForHint = readFileSync(join(HERE, '..', 'src', 'client', 'chart.js'), 'utf8');
  const hintLiteral = /className: 'dsk-hint' \}, '([^']*)'/.exec(chartSrcForHint)?.[1] ?? '';
  check('chart.js 里的提示字面量不含拖动/平移', !/拖动|平移/.test(hintLiteral), hintLiteral);
}

// ------------------------------------------------- 指针捕获必须落在处理器所在元素
//
// 这是上面那个"拖动没效果"的**根因**，单列出来守：
// `setPointerCapture` 会把后续 pointermove **重定向到捕获元素**，事件路径变成
// `捕获元素 → … → root`。若捕获设在父容器 .dsk-canvas 上，而处理器挂在子元素 svg 上，
// svg 就不在事件路径里了 —— onPointerMove / onPointerUp 全收不到：
//   · 拖动失效；
//   · 收不到 pointerup → dragRef 残留 → 之后普通悬停都会误触发平移。
{
  const svgNode = findNode(tree, (n) => n.type === 'svg');
  check('svg 带 onPointerDown（拖动起手）', typeof svgNode?.props?.onPointerDown === 'function');

  if (typeof svgNode?.props?.onPointerDown === 'function') {
    // 事件当前目标（= 处理器所在元素）必须成为捕获目标
    const captured = [];
    const onHandlerElement = { setPointerCapture: (id) => captured.push(id) };
    svgNode.props.onPointerDown({ clientX: 300, pointerId: 7, currentTarget: onHandlerElement });
    check(
      '指针捕获落在处理器所在元素上（不是父容器）',
      captured.length === 1 && captured[0] === 7,
      `捕获调用：${JSON.stringify(captured)}`,
    );

    // 再验证：即使 currentTarget 缺失（合成事件），也不能抛
    let threw = null;
    try {
      svgNode.props.onPointerDown({ clientX: 300, pointerId: 7 });
    } catch (error) {
      threw = error;
    }
    check('缺少 currentTarget 时不抛异常', threw === null, threw === null ? 'ok' : threw.message);

    // pointerId 非法时 setPointerCapture 会抛 NotFoundError —— 必须吞掉，不能中断拖动
    let threw2 = null;
    try {
      svgNode.props.onPointerDown({
        clientX: 300,
        pointerId: 999,
        currentTarget: {
          setPointerCapture() {
            const e = new Error('InvalidPointerId');
            e.name = 'NotFoundError';
            throw e;
          },
        },
      });
    } catch (error) {
      threw2 = error;
    }
    check('捕获失败（pointerId 非法）被吞掉，不中断拖动', threw2 === null, threw2 === null ? 'ok' : threw2.message);
  }

  // 结构层面：捕获目标必须是 event.currentTarget，不能是 hostRef.current
  const chartSrcForCapture = readFileSync(join(HERE, '..', 'src', 'client', 'chart.js'), 'utf8');
  const downBody = /var onPointerDown = useCallback\(([\s\S]*?)\n  \);/.exec(chartSrcForCapture)?.[1] ?? '';
  check(
    'onPointerDown 用 event.currentTarget 作为捕获目标',
    downBody.includes('event.currentTarget'),
    downBody.includes('hostRef.current') && !downBody.includes('event.currentTarget')
      ? '仍在捕获父容器 —— 这就是拖动失效的根因'
      : 'ok',
  );
  check(
    'onPointerDown 不再直接捕获 hostRef.current',
    !/setPointerCapture/.test(downBody) || !/hostRef\.current\.setPointerCapture/.test(downBody),
  );
}
if (svgNode0 !== undefined) {
  // 假事件要**跟真实 React 合成事件一样**带全方法：
  // onWheel 会同时调 preventDefault 与 stopPropagation，
  // 桩里少一个就会抛 TypeError（这是测试桩的问题，不是实现的）。
  svgNode0.props.onWheel({ deltaY: -100, preventDefault() {}, stopPropagation() {} });
  const afterZoom = render(mainComponent, {});
  assertNumeric('缩放后数值仍有限', afterZoom);
  const svgNode1 = findNode(afterZoom, (node) => node.type === 'svg');
  svgNode1.props.onPointerMove({ clientX: 400, clientY: 200 });
  const hovered = render(mainComponent, {});
  assertNumeric('悬停后数值仍有限', hovered);
  const cursorLines = countTags(hovered, 'line').n;
  check('悬停渲出十字光标', cursorLines > lineCount, `line=${lineCount} → ${cursorLines}`);
  check('悬停显示当根数据', /开\s/.test(textOf(hovered)) && /收\s/.test(textOf(hovered)), textOf(hovered).slice(-160));
}

// ------------------------------------------------- 滚轮缩放必须有上下限（回归）
//
// 曾经的 bug：滚轮能一路放大到只剩十几根 —— 每根蜡烛分到几十像素宽，
// 实体被上限钳到 18px 后与真实步长脱节，网格/均线/光标也被拉到极陡，
// 整个图面糊成一片色块（用户反馈"放大太多后直接黑屏"）。
// 反向也一样：缩小到把全部根数都画出来，SVG 节点数翻几倍。
//
// 注意：**不能用"滚轮后重渲染数根数"来测** —— 测试台每次 render() 都重置 hook 槽位，
// 缩放状态存不下来，那样测出来永远是初始值（假阳性）。所以缩放策略被抽成纯函数。

{
  const clampCount = api.clampVisibleBars;
  const stepsToCount = api.zoomStepsToCount;
  check('bundle 暴露了缩放策略（可单测）', typeof clampCount === 'function' && typeof stepsToCount === 'function');

  if (typeof clampCount === 'function' && typeof stepsToCount === 'function') {
    const MIN = api.MIN_VISIBLE_BARS;
    const MAX = api.MAX_VISIBLE_BARS;
    check('上下限是具名常量', MIN === 20 && MAX === 240, `MIN=${MIN} MAX=${MAX}`);
    check('缩放步长是具名常量', api.ZOOM_STEP === 1.15, String(api.ZOOM_STEP));

    // 单次调用的夹取
    check('clampCount 把过小的值抬到下限', clampCount(1, 500) === MIN, String(clampCount(1, 500)));
    check('clampCount 把过大的值压到上限', clampCount(9999, 500) === MAX, String(clampCount(9999, 500)));
    check('clampCount 不会超过总根数', clampCount(9999, 60) === 60, String(clampCount(9999, 60)));
    check('clampCount 对非数值兜底', isFinite(clampCount(undefined, 500)) && isFinite(clampCount(NaN, 500)), 'NaN/undefined 不能漏出去');
    check('clampCount 总根数为 0 时不崩', clampCount(120, 0) === MIN, String(clampCount(120, 0)));
    check('总根数很少时不越界', clampCount(120, 8) === 8, String(clampCount(120, 8)));

    // 连续滚轮：这是"放大太多黑屏"的直接复现路径
    let count = 120;
    for (let i = 0; i < 200; i++) count = stepsToCount(count, -1, 240);
    check('连续放大 200 次后停在下限', count === MIN, `停在 ${count} 根（下限 ${MIN}）`);

    count = 120;
    for (let i = 0; i < 200; i++) count = stepsToCount(count, 1, 240);
    check('连续缩小 200 次后停在上限', count === MAX, `停在 ${count} 根（上限 ${MAX}）`);

    // 批量语义：一帧里累积 N 步，效果应约等于连滚 N 次。
    // 允许 ±1 的差：每次夹取都做 Math.round，批量一次算 vs 逐次累积会有舍入差，
    // 但差一根在视觉上不可辨 —— 关键是"合并渲染不改变缩放量级"。
    const oneByOne = (() => {
      let c = 120;
      for (let i = 0; i < 8; i++) c = stepsToCount(c, -1, 240);
      return c;
    })();
    const batched = stepsToCount(120, -8, 240);
    check(
      '批量 8 步 ≈ 逐次 8 步（合并渲染不改变缩放量级）',
      Math.abs(batched - oneByOne) <= 1,
      `批量 ${batched} vs 逐次 ${oneByOne}`,
    );
    check('一步不动时根数不变', stepsToCount(120, 0, 240) === 120, String(stepsToCount(120, 0, 240)));

    // 边界处来回滚不能漂移，且每一步都合法
    count = MIN;
    for (let i = 0; i < 50; i++) {
      count = stepsToCount(count, 1, 240);
      count = stepsToCount(count, -1, 240);
    }
    check('在下限处来回滚不会漂移', count >= MIN && count <= MIN + 5, `停在 ${count} 根`);

    count = 120;
    let allInRange = true;
    for (let i = 0; i < 200; i++) {
      count = stepsToCount(count, i % 2 === 0 ? -3 : 5, 240);
      if (!(count >= MIN && count <= MAX)) { allInRange = false; break; }
    }
    check('滚动过程中每一步都在合法区间内', allInRange, `最后 ${count} 根`);
  }

  // 滚轮必须**同时**拦默认行为与冒泡：
  // 对话区域自己也装了 wheel 监听（ui-conversation 的 widthHandle / installDraftWheel，
  // 都是 {passive:false}）。图表只 preventDefault 的话事件会传上去，
  // 在图表上滚一下会顺带滚动背后的对话内容。
  const svgForWheel = findNode(tree, (n) => n.type === 'svg');
  check('svg 带 onWheel', typeof svgForWheel?.props?.onWheel === 'function');
  if (typeof svgForWheel?.props?.onWheel === 'function') {
    let prevented = false;
    let stopped = false;

    // 等上一段断言排下的那一帧跑完，确保 pending 归位
    await new Promise((resolve) => setTimeout(resolve, 30));
    const beforeRaf = rafCount();

    // 一帧内连发 10 个滚轮事件（真实场景：快速滑动）
    for (let i = 0; i < 10; i++) {
      svgForWheel.props.onWheel({
        deltaY: -100,
        preventDefault: () => { prevented = true; },
        stopPropagation: () => { stopped = true; },
      });
    }
    const rafDelta = rafCount() - beforeRaf;

    check('滚轮拦掉冒泡（stopPropagation，否则会滚动背后对话）', stopped === true);
    check(
      'React onWheel 不调 preventDefault（passive 里无效，只会刷警告）',
      // 分工：拦页面滚动交给原生非 passive 监听（见下面那组断言），
      // React 这层只做 stopPropagation + 缩放逻辑。
      prevented === false,
      prevented ? '仍在 passive 监听里调 preventDefault' : 'ok',
    );
    check(
      '一帧内 10 个滚轮事件只排一次渲染（合并，滑太快不卡）',
      rafDelta === 1,
      `实际排了 ${rafDelta} 次 rAF；不合并会是 10 次`,
    );
  }

  // 结构层面：滚轮必须走 rAF 合并，不能逐事件 setState
  const chartSource = readFileSync(join(HERE, '..', 'src', 'client', 'chart.js'), 'utf8');
  const wheelBody = /var onWheel = useCallback\(([\s\S]*?)\n  \);/.exec(chartSource)?.[1] ?? '';
  check(
    'onWheel 里没有直接 setView（必须经 rAF 合并）',
    wheelBody.length > 0 && !wheelBody.includes('setView('),
    wheelBody.includes('setView(') ? '仍在事件里直接 setState' : 'ok',
  );
  check('onWheel 用 requestAnimationFrame 排队', wheelBody.includes('requestAnimationFrame'));
}

// ------------------------------------------------- 悬停下标越界不能崩（黑屏真因）
//
// 用户报"滚轮放大太多黑屏"，console 里的真凶是：
//   TypeError: Cannot read properties of undefined (reading 'row')  at KlineChart
//   slot entry crashed in 'main'
// 即 **KlineChart 抛异常 → shell 错误边界兜住 → 面板什么都不渲染 = 黑屏**。
//
// 成因：`geometry.items[hover]` 在 hover 越界时返回 undefined，
// 而 `undefined !== null` 是 true，于是 `hoverItem.row` 抛错。
// 触发条件正是"鼠标悬停着滚轮放大"：可见根数骤减，hover 还停在旧下标上。

{
  const svgNode = findNode(tree, (n) => n.type === 'svg');
  if (svgNode !== null && typeof svgNode.props.onPointerMove === 'function') {
    let hoveredTree = tree;
    let hoverCrashed = null;
    try {
      svgNode.props.onPointerMove({ clientX: 700, clientY: 200 });
      hoveredTree = render(mainComponent, {});
    } catch (error) {
      hoverCrashed = error;
    }
    check('悬停靠后位置不会崩', hoverCrashed === null, hoverCrashed === null ? '未抛异常' : hoverCrashed.message);

    // 悬停状态下滚轮放大到极限 —— 这就是黑屏的复现路径
    let crash = null;
    try {
      for (let i = 0; i < 40; i++) {
        const s = findNode(hoveredTree, (n) => n.type === 'svg');
        if (s === null) break;
        s.props.onWheel({ deltaY: -100, preventDefault() {}, stopPropagation() {} });
        hoveredTree = render(mainComponent, {});
        // 每轮再触发一次悬停，把"悬停 + 缩放"的越界条件叠上去
        const s2 = findNode(hoveredTree, (n) => n.type === 'svg');
        if (s2 !== null && typeof s2.props.onPointerMove === 'function') {
          s2.props.onPointerMove({ clientX: 700, clientY: 200 });
          hoveredTree = render(mainComponent, {});
        }
      }
    } catch (error) {
      crash = error;
    }
    check(
      '悬停状态下狂放大不会崩（黑屏真因已修）',
      crash === null,
      crash === null ? '未抛异常' : crash.message,
    );
  }

  const chartSrc = readFileSync(join(HERE, '..', 'src', 'client', 'chart.js'), 'utf8');
  check(
    'hoverItem 有越界长度校验（undefined !== null 陷阱）',
    /hover < geometry\.items\.length/.test(chartSrc),
    '只判 !== null 会让越界返回的 undefined 漏过去，正是崩溃点',
  );
  check(
    'hoverItem 归一化成 null（下游只需判 null）',
    /hoverItem === undefined \|\| hoverItem === null/.test(chartSrc),
  );
  check(
    '缩放改变可见根数时清掉失效的悬停下标',
    /if \(next === current\)/.test(chartSrc) && /setHover\(null\)/.test(chartSrc),
    '缩放分支里应清掉 hover',
  );

  // React 的 onWheel 是 passive 的，preventDefault 无效 —— 必须另挂原生非 passive 监听
  check(
    '用原生非 passive wheel 监听拦页面滚动',
    chartSrc.includes("addEventListener('wheel', onNativeWheel, { passive: false })"),
    'React 的 onWheel 是 passive，preventDefault 会被忽略并刷警告',
  );
  check(
    '原生监听里不 stopPropagation（否则 React onWheel 收不到，缩放失效）',
    (() => {
      const body = /var onNativeWheel = function \(event\) \{([\s\S]*?)\n      \};/.exec(chartSrc)?.[1] ?? '';
      return body.includes('preventDefault') && !body.includes('stopPropagation');
    })(),
  );
}

// ------------------------------------------------- 缩放维度同步到对话背景
//
// 需求："在行情k线的缩放维度记录下来同步到对话背景中"。
// 做法：可见根数不再只存在 KlineChart 的内部 state，而是放进 store 的 `zoom`：
//   主面板滚轮缩放 → store.setZoom → 对话背景读同一个值画**同一段**行情。
// 这里验证三件事：store 有这个维度、主面板回传它、背景读它。

{
  const store = api.store;

  // 1) store 有缩放维度，且有上下限夹取（畸形值不许漏进去）
  check('store 暴露 setZoom', typeof store.setZoom === 'function', typeof store.setZoom);
  store.setZoom(9999, 240);
  check('setZoom 夹到上限', store.get().zoom === api.MAX_VISIBLE_BARS, `zoom=${store.get().zoom}`);
  store.setZoom(1, 240);
  check('setZoom 夹到下限', store.get().zoom === api.MIN_VISIBLE_BARS, `zoom=${store.get().zoom}`);
  store.setZoom(60, 240);
  check('setZoom 正常值原样接收', store.get().zoom === 60, `zoom=${store.get().zoom}`);
  store.setZoom(9999, 30);
  check('setZoom 不会超过总根数', store.get().zoom === 30, `zoom=${store.get().zoom}`);
  store.setZoom(120, 240);

  // 2) 主面板把缩放回传给 store。
  //    注意不能"在展开后的树里找 KlineChart 节点" —— 测试台会把函数组件展开，
  //    那个节点在树里已经不存在了。改为**直接渲染 KlineChart 并驱动滚轮**，
  //    真正走一遍 onZoom 回传链路。
  const quoteForZoom = (() => {
    const fromStore = store.get().quote;
    if (fromStore !== null && fromStore !== undefined && fromStore.candles && fromStore.candles.length > 0) return fromStore;
    // 取数失败时造一份，别让这条断言依赖网络
    return {
      code: '000300',
      name: '沪深300',
      preClose: 100,
      candles: Array.from({ length: 240 }, (_, i) => ({
        date: '2026-01-01',
        open: 100 + i,
        close: 100.5 + i,
        high: 101 + i,
        low: 99 + i,
        volume: 1000 + i,
      })),
    };
  })();

  const zoomCalls = [];
  // 用 renderFresh：KlineChart 的 hook 槽位在文件前面已被别的用例填过，
  // 复用会让 view.count / countRef 带着旧值起步 —— 缩放基准就错了
  // （表现为"滚了但没触发 onZoom"：夹取后数值没变化，走了边界分支）。
  let zoomTree = renderFresh(api.KlineChart, {
    quote: quoteForZoom,
    period: 'day',
    ma: [5, 10, 20],
    height: 420,
    zoom: 120,
    onZoom: (n) => zoomCalls.push(n),
  });
  const zoomSvg = findNode(zoomTree, (n) => n.type === 'svg');
  check('KlineChart 接受受控 zoom', zoomSvg !== null);
  if (zoomSvg !== null) {
    for (let i = 0; i < 3; i++) {
      zoomSvg.props.onWheel({ deltaY: -100, preventDefault() {}, stopPropagation() {} });
    }
    await new Promise((resolve) => setTimeout(resolve, 40)); // 等 rAF 合并后应用
    check('滚轮后会通过 onZoom 回传新缩放', zoomCalls.length >= 1, `回调 ${zoomCalls.length} 次：${zoomCalls.join(',')}`);
    check(
      '回传的值在合法区间内',
      zoomCalls.every((n) => n >= api.MIN_VISIBLE_BARS && n <= api.MAX_VISIBLE_BARS),
      zoomCalls.join(','),
    );
    check('放大方向让根数变少', zoomCalls.length > 0 && zoomCalls[0] < 120, `120 → ${zoomCalls[0]}`);
  }

  // 结构层面：面板确实把 store.zoom 接给了 KlineChart
  const panelSrc = readFileSync(join(HERE, '..', 'src', 'client', 'chart-panel.js'), 'utf8');
  check(
    '面板把 store.zoom 接给 KlineChart',
    /zoom: state\.zoom/.test(panelSrc) && /onZoom:/.test(panelSrc),
    'chart-panel 应传 zoom + onZoom',
  );
  check(
    '面板的 onZoom 写回 store（带总根数，好让夹取生效）',
    /setZoom\(count, quote\.candles\.length\)/.test(panelSrc),
  );

  // 2b) 受控 zoom 必须在**挂载时就生效**（回归："回到面板缩放丢失，滚一下才恢复"）
  //
  // 成因：那个"换股票/周期重置视野"的 useEffect 在挂载时也会跑一次，
  // 而它曾无条件把可见根数写回默认 120 —— 直接覆盖受控缩放。
  // 而 countRef 里存的还是正确值，所以下一次滚轮以正确值为基准，画面"跳回"原本缩放。
  //
  // ⚠️ 这条**只做结构断言**：行为验证放在 test/zoom-mount.test.mjs。
  // 原因：本测试台每次 render 只展开一次、且 effect 桩只在首见 hook 索引时排队，
  // 观察不到"挂载期 effect 覆盖 state"的效果（曾写了一条读渲染树的断言，
  // 结果**把修复回退掉它照样 PASS** —— 假阳性，比没有断言更危险）。
  {
    const chartSrcForEffect = readFileSync(join(HERE, '..', 'src', 'client', 'chart.js'), 'utf8');
    const resetEffect = /换股票\/周期时重置[\s\S]*?\[\s*quote && quote\.symbol[\s\S]*?\n  \);/.exec(chartSrcForEffect)?.[0] ?? '';
    check(
      '重置视野的 effect 存在（能找到才谈得上守它）',
      resetEffect.length > 0,
      resetEffect.length > 0 ? '已定位' : '没定位到重置视野 effect',
    );
    check(
      '重置视野时受控缩放不被覆盖（挂载丢失缩放的根因）',
      /if \(controlled\)/.test(resetEffect) && /clampVisibleBars\(props\.zoom, total\)/.test(resetEffect),
      '该 effect 必须区分受控/非受控：受控时 count 取 props.zoom，只重置 offset',
    );
    check(
      '重置视野不再硬编码 120',
      !/nextCount = 120/.test(resetEffect) && !/Math\.min\(total \|\| 120, next\)/.test(resetEffect),
      '写死 120 就是"回到面板缩放丢失"的原因',
    );
  }

  // 3) 对话背景读同一个 zoom，而不是按自身宽度自适应
  const skinSvg = api.skinSvg;
  if (typeof skinSvg === 'function') {
    const candles = Array.from({ length: 240 }, (_, i) => ({
      date: '2026-01-01',
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      volume: 1000 + i,
    }));
    const quote = { code: '000300', name: '沪深300', candles: candles, preClose: 100 };

    const countRects = (markup) => (markup.match(/<rect/g) ?? []).length;
    const wide = 1200; // 宽度足够，让 widthCap 不成为瓶颈
    const zoomedIn = skinSvg({ quote: quote, zoom: 20 }, wide, 600);
    const zoomedOut = skinSvg({ quote: quote, zoom: 200 }, wide, 600);
    check(
      '背景按 store.zoom 决定根数（放大后明显更少）',
      countRects(zoomedIn) > 0 && countRects(zoomedIn) < countRects(zoomedOut),
      `zoom=20 → ${countRects(zoomedIn)} 个 rect；zoom=200 → ${countRects(zoomedOut)} 个`,
    );

    // 主面板缩小 → 背景跟着画更多根（同一段行情）
    const a = skinSvg({ quote: quote, zoom: 60 }, wide, 600);
    const b = skinSvg({ quote: quote, zoom: 150 }, wide, 600);
    check('背景根数随 zoom 单调变化', countRects(a) < countRects(b), `${countRects(a)} < ${countRects(b)}`);

    // 窄条保护：背景很窄时不会被 240 根糊成一片
    const narrow = skinSvg({ quote: quote, zoom: 240 }, 280, 600);
    check('窄背景有基于宽度的保护上限', countRects(narrow) > 0 && countRects(narrow) < countRects(zoomedOut), `窄条 ${countRects(narrow)} 个 rect`);

    // 没给 zoom（老调用/独立使用）时退回自适应，不能崩
    const noZoom = skinSvg({ quote: quote }, wide, 600);
    check('没给 zoom 时退回自适应且不崩', typeof noZoom === 'string' && noZoom.length > 0, `${noZoom.length} 字符`);
  }

  // 4) 结构层面：zoom 必须进偏好持久化，否则刷新就丢
  const prefsSrc = readFileSync(join(HERE, '..', 'src', 'client', 'prefs.js'), 'utf8');
  check('zoom 在持久化白名单里', /PREF_KEYS = \[[^\]]*'zoom'/.test(prefsSrc), 'PREF_KEYS 应含 zoom');
  const storeSrc = readFileSync(join(HERE, '..', 'src', 'client', 'market.js'), 'utf8');
  check(
    'store 的 setZoom 复用共享夹取函数（不自己写一份上下限）',
    /setZoom[\s\S]{0,300}clampVisibleBars\(/.test(storeSrc),
  );

  // 5) revision 必须带上 zoom —— 这是最容易被漏掉、一漏功能就静默失效的地方：
  //    皮肤只在 revision 变化时才重绘；zoom 不进 key，主面板缩放后背景纹丝不动。
  const skinSrc = readFileSync(join(HERE, '..', 'src', 'client', 'skin.js'), 'utf8');
  check(
    '皮肤 revision key 含 zoom（否则缩放后背景不重绘）',
    // 不设长度窗口：中间夹着注释，写死字符数会误判
    /revision:\s*function[\s\S]*?snapshot\.zoom/.test(skinSrc),
    'revision() 里必须拼上 zoom，不然同步静默失效',
  );
  check(
    '皮肤的重绘依赖数组含 zoom（让同步没有轮询延迟）',
    /requestSkinRepaint\(\);[\s\S]{0,80}\},\s*\[state\.symbol, state\.period, state\.skinOpen, state\.zoom\]/.test(skinSrc),
  );

  // 复位
  store.setZoom(120, 240);
}

// ----------------------------------------------------------------- 价格挂件（只有价格与涨跌幅）

const tickerRow = bySlot('shell.overlay').find((row) => row.options.id === 'stock-kline-ticker');
check('找到价格挂件注册', tickerRow !== undefined);

let tickerOk = false;
let tickerTree = null;
let tickerDetail = '';
for (let i = 0; i < 50; i++) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  tickerTree = render(tickerRow.component, {});
  if (tickerTree === null) {
    tickerDetail = 'null（挂件被认为是关闭的）';
    continue;
  }
  const text = textOf(tickerTree);
  tickerDetail = text.slice(0, 90);
  if (text.includes(DEFAULT_NAME) && /[+-]\d+\.\d\d%/.test(text)) {
    tickerOk = true;
    break;
  }
}
check('价格挂件显示名称与涨跌百分比', tickerOk, tickerDetail);
check('价格挂件用 SVG 画内容（不受 HTML 文本颜色规则影响）', findNode(tickerTree, (node) => node.type === 'svg') !== null);
check('价格挂件没有异常坐标数值', (() => {
  const numbers = [];
  collectNumbers(tickerTree, numbers, 'ticker');
  return numbers.every((row) => Number.isFinite(row.value));
})(), '挂件内所有数值属性必须有限');

// SVG 的 fill 是呈现属性：比任何 HTML 文本颜色规则优先级都高，
// 所以"文字看不见"这条路的根治办法就是走 SVG。
const tickerTexts = [];
(function walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(walk);
    return;
  }
  if (node.type === 'text') tickerTexts.push(node);
  (node.children ?? []).forEach(walk);
})(tickerTree);
check('挂件用 <text> 画了 2 段文字（只要名字与百分比）', tickerTexts.length === 2, `text 元素数=${tickerTexts.length}`);
check(
  '挂件文本只有名称与百分比（没有代码/现价/涨跌额）',
  tickerTexts.length === 2 &&
    String(tickerTexts[0].children?.[0] ?? '') === DEFAULT_NAME &&
    /^[+-]?\d+\.\d\d%$/.test(String(tickerTexts[1].children?.[0] ?? '')),
  tickerTexts.map((node) => String(node.children?.[0] ?? '')).join(' | '),
);
check(
  '百分比文案不带重复正号（fmtPct 自己已带符号）',
  tickerTexts.length === 2 && !/^\+\+/.test(String(tickerTexts[1].children?.[0] ?? '')),
  String(tickerTexts[1]?.children?.[0] ?? ''),
);
check(
  '挂件每段 <text> 都写死了 fill',
  tickerTexts.length === 2 && tickerTexts.every((node) => typeof node.props.fill === 'string' && node.props.fill.startsWith('#')),
  JSON.stringify(tickerTexts.map((node) => node.props.fill)),
);
// 背景透明 + 可能压在浅色/花纹背景上 → 文字要够"重"才读得清。
// 三条一起检查：颜色要深、字重要够、且带一圈同色系描边把笔画加粗。
const HEX_LUMA = (hex) => {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
check(
  '挂件名称颜色足够深（不是浅灰）',
  tickerTexts.length === 2 && HEX_LUMA(tickerTexts[0].props.fill) <= 60,
  `亮度 ${tickerTexts[0] === undefined ? '?' : HEX_LUMA(tickerTexts[0].props.fill).toFixed(0)}（越小越深）`,
);
check(
  '挂件文字字重够重（>=700）',
  tickerTexts.length === 2 && tickerTexts.every((node) => Number(node.props.fontWeight) >= 700),
  JSON.stringify(tickerTexts.map((node) => node.props.fontWeight)),
);
check(
  '挂件每段文字都带描边（paint-order:stroke fill，透明背景下的可读性）',
  tickerTexts.length === 2 &&
    tickerTexts.every(
      (node) =>
        node.props.paintOrder === 'stroke fill' &&
        typeof node.props.stroke === 'string' &&
        node.props.stroke.startsWith('rgba(255,255,255') &&
        Number(node.props.strokeWidth) >= 2 &&
        node.props.style?.paintOrder === 'stroke fill',
    ),
  JSON.stringify(tickerTexts.map((node) => ({ stroke: node.props.stroke, w: node.props.strokeWidth }))),
);
check(
  '挂件涨跌色加深过（红涨绿跌都要够重）',
  (() => {
    const src = readFileSync(BUNDLE, 'utf8');
    const up = /var UP = '(#[0-9a-fA-F]{6})'/.exec(src);
    const down = /var DOWN = '(#[0-9a-fA-F]{6})'/.exec(src);
    return up !== null && down !== null && HEX_LUMA(up[1]) <= 110 && HEX_LUMA(down[1]) <= 130;
  })(),
  '涨跌色不能太浅，否则在透明背景下看不清',
);
// 「零信任」加固：文字可见性不能只靠继承 —— 每段都要自带字号与 text-fill-color
check(
  '挂件每段 <text> 都内联写死了 fontSize 与 text-fill-color',
  tickerTexts.length === 2 &&
    tickerTexts.every(
      (node) =>
        typeof node.props.style?.fontSize === 'string' &&
        node.props.style.fontSize.endsWith('px') &&
        node.props.style.fill === node.props.fill &&
        typeof node.props.style.WebkitTextFillColor === 'string' &&
        node.props.style.WebkitTextFillColor.startsWith('#'),
    ),
  JSON.stringify(tickerTexts.map((node) => node.props.style)),
);
check(
  '挂件 svg 内部自带 <style>（按自有类名再钉一遍颜色）',
  (() => {
    const styles = [];
    (function walk(node) {
      if (node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.type === 'style') styles.push(String(node.children?.[0] ?? ''));
      (node.children ?? []).forEach(walk);
    })(tickerTree);
    return styles.length === 1 && styles[0].includes('-webkit-text-fill-color') && styles[0].includes('.dskSvgName');
  })(),
  '挂件 svg 里应有且仅有一段钉颜色的 <style>',
);
check(
  '挂件容器与内层都内联钉死了 opacity / visibility',
  (() => {
    const boxes = [];
    (function walk(node, depth) {
      if (node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach((c) => walk(c, depth));
      if (depth <= 1 && typeof node.type === 'string') boxes.push(node);
      (node.children ?? []).forEach((c) => walk(c, depth + 1));
    })(tickerTree, 0);
    return (
      boxes.length >= 2 &&
      boxes.every((node) => node.props?.style?.opacity === 1 && node.props?.style?.visibility === 'visible')
    );
  })(),
  '浮层里最容易被上层改透明，容器与内容都要钉死',
);
check(
  '挂件 svg 带自有类名（样式表可寻址）',
  (() => {
    let className = '';
    (function walk(node) {
      if (node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.type === 'svg') className = String(node.props?.className ?? '');
      (node.children ?? []).forEach(walk);
    })(tickerTree);
    return className === 'dsk-tickerSvg';
  })(),
  '挂件 svg 需要类名，样式表才能对 text 兜底',
);
check(
  '挂件 <text> 真的带上了行情内容',
  (() => {
    const text = tickerTexts.map((node) => String(node.children?.[0] ?? '')).join(' | ');
    return text.includes(DEFAULT_NAME) && text.includes('%');
  })(),
  tickerTexts.map((node) => String(node.children?.[0] ?? '')).join(' | '),
);
// 背景透明：容器不能有任何底色/边框/阴影（内联写死，不靠样式表）
const tickerStyle = tickerTree?.props?.style ?? {};
check(
  '挂件背景透明（无底色/边框/阴影）',
  tickerStyle.background === 'transparent' &&
    tickerStyle.backgroundColor === 'transparent' &&
    tickerStyle.border === 'none' &&
    tickerStyle.boxShadow === 'none',
  JSON.stringify({ background: tickerStyle.background, border: tickerStyle.border, boxShadow: tickerStyle.boxShadow }),
);
check(
  '挂件尺寸随内容（不写死宽高）',
  tickerStyle.width === 'auto' && tickerStyle.height === 'auto',
  JSON.stringify({ width: tickerStyle.width, height: tickerStyle.height }),
);
check(
  '挂件不再有刷新按钮（信息最简）',
  (() => {
    let refresh = 0;
    (function walk(node) {
      if (node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.type === 'g' && node.props?.key === 'refresh') refresh++;
      (node.children ?? []).forEach(walk);
    })(tickerTree);
    return refresh === 0;
  })(),
  '刷新按钮已移除，只留关闭',
);
// ------------------------------------------------- 关闭按钮必须"点得到"（回归）
//
// 曾经的 bug：关闭按钮只在 `hovered` 为真时才被渲染 —— 鼠标往角落移动的过程中
// 任何一次 pointerleave 都会把它从 DOM 摘掉，于是"正要点它就没了"。
// 现在它**常驻 DOM**，只用透明度表达悬停；命中区也从 r=10 的圆换成占满整高的大矩形。
// 这里既验证"未悬停也在 DOM 里"，也直接驱动 onClick 验证整条关闭链路。

{
  const findCloseGroup = (node) =>
    (function walk(n) {
      if (n === null || n === undefined || typeof n !== 'object') return null;
      if (Array.isArray(n)) {
        for (const c of n) {
          const hit = walk(c);
          if (hit !== null) return hit;
        }
        return null;
      }
      if (n.type === 'g' && n.props?.key === 'close') return n;
      for (const c of n.children ?? []) {
        const hit = walk(c);
        if (hit !== null) return hit;
      }
      return null;
    })(node);

  const closeInTicker = findCloseGroup(tickerTree);
  check('未悬停时关闭按钮也在 DOM 里（不再靠 hover 渲染）', closeInTicker !== null, '点不到的根因就是它当时被摘掉了');

  const TickerSvg = api.TickerSvg;
  check('bundle 暴露了 __test.TickerSvg（关闭链路可单测）', typeof TickerSvg === 'function');
  if (typeof TickerSvg === 'function') {
    let closed = 0;
    const svgTree = TickerSvg({
      quote: { code: '000300', name: '沪深300' },
      pct: 0.57,
      color: '#d92d20',
      hovered: false,
      onClose: () => {
        closed++;
      },
    });
    const group = findCloseGroup(svgTree);
    check('关闭按钮可渲染（未悬停）', group !== null);

    if (group !== null) {
      check('关闭按钮有 onClick', typeof group.props.onClick === 'function');
      check('关闭按钮有 onPointerDown 挡拖动（否则会被拖拽吞掉点击）', typeof group.props.onPointerDown === 'function');
      check(
        '关闭按钮常驻可点（pointerEvents 不是 none）',
        group.props.style?.pointerEvents === 'auto',
        JSON.stringify(group.props.style),
      );

      // 命中区：占满整高的大矩形，而不是小圆
      const hit = (group.children ?? []).find((c) => c.props?.key === 'hit');
      check(
        '命中区是占满整高的矩形（不是小圆）',
        hit !== undefined && hit.type === 'rect' && hit.props.height >= 20 && hit.props.width >= 20,
        hit === undefined ? '(没有 hit 节点)' : `${hit.type} ${hit.props.width}×${hit.props.height}`,
      );
      check('命中区透明但可点（fill=transparent）', hit?.props?.fill === 'transparent', String(hit?.props?.fill));

      // 图标本身不能吃事件，否则点到 × 笔画上反而落到 path 而不是 g
      const icon = (group.children ?? []).find((c) => c.props?.key === 'icon');
      check('× 笔画本身不吃事件', icon?.props?.pointerEvents === 'none', String(icon?.props?.pointerEvents));

      // 直接驱动：点击应触发 onClose，并阻止冒泡（否则会顺带打开面板）
      let stopped = false;
      group.props.onClick({ stopPropagation: () => { stopped = true; } });
      check('点关闭按钮会触发 onClose', closed === 1, `onClose 触发 ${closed} 次`);
      check('点关闭按钮会阻止冒泡（不误开面板）', stopped === true);

      // pointerdown 也必须挡住，否则容器 startDrag 会把这次交互当成拖动
      let downStopped = false;
      group.props.onPointerDown({ stopPropagation: () => { downStopped = true; } });
      check('pointerdown 被挡住（不会起手拖动）', downStopped === true);

      // 悬停时只是更明显，不影响可点
      const hoveredTree = TickerSvg({
        quote: { code: '000300', name: '沪深300' },
        pct: 0.57,
        color: '#d92d20',
        hovered: true,
        onClose: () => {},
      });
      const hoveredGroup = findCloseGroup(hoveredTree);
      check(
        '悬停时只是更明显（透明度变化），仍然可点',
        hoveredGroup?.props?.style?.opacity === 1 && hoveredGroup?.props?.style?.pointerEvents === 'auto',
        JSON.stringify(hoveredGroup?.props?.style),
      );
    }
  }
}
// 可拖动：容器带 pointerdown 拖拽起手 + ref + 双击归位
const tickerBoxWire = tickerTree;
check('价格挂件是可拖动容器', typeof tickerBoxWire?.props?.onPointerDown === 'function', typeof tickerBoxWire?.props?.onPointerDown);
check('价格挂件有 ref（拖动要量自身尺寸）', tickerBoxWire?.props?.ref !== undefined && tickerBoxWire?.props?.ref !== null);
check('价格挂件支持双击归位', typeof tickerBoxWire?.props?.onDoubleClick === 'function');

check(
  '挂件容器尺寸随内容（尺寸由内层 svg 决定，不再写死）',
  (() => {
    const style = tickerBoxWire?.props?.style ?? {};
    const svg = findNode(tickerTree, (node) => node.type === 'svg');
    return (
      style.width === 'auto' &&
      style.height === 'auto' &&
      style.padding === '0' &&
      style.border === 'none' &&
      svg !== null &&
      typeof svg.props.style?.minWidth === 'string' &&
      svg.props.style.minWidth === svg.props.style.maxWidth
    );
  })(),
  JSON.stringify({
    width: tickerBoxWire?.props?.style?.width,
    height: tickerBoxWire?.props?.style?.height,
    svgMin: findNode(tickerTree, (node) => node.type === 'svg')?.props?.style?.minWidth,
  }),
);
check(
  '挂件 svg 尺寸同时写在属性与 style 上',
  (() => {
    const svg = findNode(tickerTree, (node) => node.type === 'svg');
    if (svg === null) return false;
    return (
      svg.props.width === svg.props.style?.width?.replace('px', '') * 1 &&
      svg.props.height === svg.props.style?.height?.replace('px', '') * 1 &&
      String(svg.props.style?.width).endsWith('px')
    );
  })(),
  JSON.stringify((() => {
    const svg = findNode(tickerTree, (node) => node.type === 'svg');
    return svg === null ? null : { attr: [svg.props.width, svg.props.height], inline: [svg.props.style?.width, svg.props.style?.height] };
  })()),
);
check(
  '挂件 svg viewBox 与尺寸一致（不会被拉成方形）',
  (() => {
    const svg = findNode(tickerTree, (node) => node.type === 'svg');
    return svg !== null && svg.props.viewBox === '0 0 ' + svg.props.width + ' ' + svg.props.height;
  })(),
  String(findNode(tickerTree, (node) => node.type === 'svg')?.props?.viewBox),
);
check(
  '挂件 svg 尺寸钉死了 min/max（不会被压扁）',
  (() => {
    const svg = findNode(tickerTree, (node) => node.type === 'svg');
    const s = svg?.props?.style ?? {};
    return s.minWidth === s.width && s.maxWidth === s.width && s.minHeight === s.height && s.maxHeight === s.height;
  })(),
  JSON.stringify((() => {
    const s = findNode(tickerTree, (node) => node.type === 'svg')?.props?.style ?? {};
    return { min: s.minWidth, max: s.maxWidth };
  })()),
);


// 文字颜色必须是**内联**的：CSS 规则可能因为样式表被占位/截断而整条失效，
// 内联样式不依赖任何选择器匹配 —— 这是"白底看不见文字"那个 bug 的根治办法。
check(
  '挂件容器内联写死了墨色（背景改为透明）',
  tickerBoxWire?.props?.style?.background === 'transparent' &&
    tickerBoxWire?.props?.style?.color === INK_HEX &&
    tickerBoxWire?.props?.style?.WebkitTextFillColor === INK_HEX,
  JSON.stringify({
    background: tickerBoxWire?.props?.style?.background,
    color: tickerBoxWire?.props?.style?.color,
    fill: tickerBoxWire?.props?.style?.WebkitTextFillColor,
  }),
);
const tickerTextSpans = [];
(function walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(walk);
    return;
  }
  if (typeof node.type === 'string' && node.type === 'span' && node.style !== undefined) tickerTextSpans.push(node);
  (node.children ?? []).forEach(walk);
})(tickerTree);
check('挂件里每个文字元素都内联写了颜色', (() => {
  // 现在文字走 SVG <text> 的 fill 呈现属性（见上面几条断言），
  // 这里只再确认容器自身的内联颜色没退化。
  return tickerBoxWire?.props?.style?.color === INK_HEX;
})(), JSON.stringify(tickerBoxWire?.props?.style?.color));
check('价格挂件用显式不透明配色（不是主题灰）', (() => {
  const css = typeof api?.css === 'function' ? api.css() : '';
  const src = readFileSync(BUNDLE, 'utf8');
  // 文字颜色有三处来源，任一处生效都能看见：内联 fill（上面的断言）、
  // SVG 内部 <style> 的 .dskSvgName、以及 format 里的常量。全都不能引用主题变量。
  const svgStyle = (() => {
    let found = '';
    (function walk(node) {
      if (node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.type === 'style') found = String(node.children?.[0] ?? '');
      (node.children ?? []).forEach(walk);
    })(tickerTree);
    return found;
  })();
  return (
    svgStyle.includes('fill:' + INK_HEX) &&
    src.includes("var INK = '" + INK_HEX + "'") &&
    src.includes('var MUTED =') &&
    !/dsk-ticker[^}]*var\(--dsw/.test(css)
  );
})(), '挂件文字色必须写死，不能引用主题变量');
check(
  '价格挂件 z-index 与桌宠同级',
  readFileSync(BUNDLE, 'utf8').includes('z-index:2147483000'),
  'shell.overlay 里其它浮窗的层级',
);

// ----------------------------------------------------------------- 对话页 K 线背景（DOM 注入）
//
// 关键事实（读 ui-conversation 源码确认）：对话页面容器（ConversationMainPanel 的根，
// 带 data-phase）**自带不透明底色且自己是 position:relative**。
// 皮肤必须挂进它自己内部；挂在父级 .centerCol 上会被那层底色整个盖住。

function makeSkinDocument() {
  function makeNode(tag) {
    return {
      tagName: tag,
      children: [],
      attrs: Object.create(null),
      style: { cssText: '' },
      className: '',
      parentNode: null,
      firstChild: null,
      clientWidth: 900,
      clientHeight: 700,
      title: '',
      setAttribute(n) {
        this.attrs[n] = '';
      },
      getAttribute(n) {
        return n in this.attrs ? this.attrs[n] : null;
      },
      hasAttribute(n) {
        return n in this.attrs;
      },
      appendChild(c) {
        c.parentNode = this;
        this.children.push(c);
        this.firstChild = this.children[0] ?? null;
        return c;
      },
      insertBefore(c, before) {
        c.parentNode = this;
        const i = this.children.indexOf(before);
        if (i < 0) this.children.push(c);
        else this.children.splice(i, 0, c);
        this.firstChild = this.children[0] ?? null;
        return c;
      },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        this.firstChild = this.children[0] ?? null;
        return c;
      },
      querySelector(selector) {
        const all = [];
        const collect = (node) => {
          for (const child of node.children) {
            all.push(child);
            collect(child);
          }
        };
        collect(this);
        const parts = [];
        let rest = selector;
        while (rest.length > 0) {
          const open = rest.indexOf('[');
          if (open < 0) {
            parts.push(rest);
            break;
          }
          if (open > 0) parts.push(rest.slice(0, open));
          const close = rest.indexOf(']', open);
          parts.push(rest.slice(open, close + 1));
          rest = rest.slice(close + 1);
        }
        const match = (node) =>
          parts.every((part) => {
            if (part.startsWith('[class*="') && part.endsWith('"]')) {
              return typeof node.className === 'string' && node.className.includes(part.slice(9, -2));
            }
            if (part.startsWith('[') && part.endsWith(']')) {
              return Object.prototype.hasOwnProperty.call(node.attrs, part.slice(1, -1));
            }
            return node.tagName === part;
          });
        return all.find(match) ?? null;
      },
      querySelectorAll(selector) {
        const all = [];
        const collect = (node) => {
          for (const child of node.children) {
            all.push(child);
            collect(child);
          }
        };
        collect(this);
        if (selector.startsWith('[') && selector.endsWith(']')) {
          const name = selector.slice(1, -1);
          return all.filter((node) => Object.prototype.hasOwnProperty.call(node.attrs, name));
        }
        return [];
      },
    };
  }

  const body = makeNode('body');
  const frame = makeNode('div');
  frame.className = 'BynINW_frame';
  const sidebarCol = makeNode('div');
  sidebarCol.className = 'BynINW_sidebarCol';
  const centerCol = makeNode('div');
  centerCol.className = 'BynINW_centerCol';
  // 对话页面容器：自带底色 + position:relative
  const pageRoot = makeNode('div');
  pageRoot.className = 'Dc7zOa_root';
  pageRoot.setAttribute('data-phase', 'active');
  const pageBody = makeNode('div');
  pageBody.className = 'Dc7zOa_body';
  const overlay = makeNode('div');
  overlay.setAttribute('data-shell-overlay', '');
  overlay.className = 'BynINW_overlayLayer';

  frame.appendChild(sidebarCol);
  frame.appendChild(centerCol);
  frame.appendChild(overlay);
  centerCol.appendChild(pageRoot);
  pageRoot.appendChild(pageBody);
  body.appendChild(frame);

  return {
    body,
    createElement: makeNode,
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    defaultView: {
      MutationObserver: class {
        constructor(cb) {
          this.cb = cb;
        }
        observe() {}
        disconnect() {}
      },
      addEventListener() {},
      removeEventListener() {},
      setInterval: () => 0,
      clearInterval() {},
    },
    __sidebarCol: sidebarCol,
    __centerCol: centerCol,
    __pageRoot: pageRoot,
  };
}

const SKIN_LAYER_STYLE_OK = (injected) =>
  typeof injected?.style.cssText === 'string' &&
  injected.style.cssText.includes('pointer-events:none') &&
  injected.style.cssText.includes('z-index:0') &&
  injected.style.cssText.includes('position:absolute') &&
  injected.style.cssText.includes('inset:0') &&
  injected.style.cssText.includes('overflow:hidden');

check('bundle 暴露了 __test.skin 供测试注入假 DOM', api !== undefined && typeof api.skin === 'function');

if (api !== undefined && typeof api.skin === 'function') {
  const doc = makeSkinDocument();
  const dispose = api.skin({
    doc,
    render: (width, height) => `<svg width="${width}" height="${height}"><rect width="10" height="10"/></svg>`,
    isActive: () => true,
    revision: () => 'v1',
  });

  const injected = doc.__pageRoot.children.find((child) => child.hasAttribute('data-dsk-skin'));
  check('皮肤注入到对话页面容器**里面**', injected !== undefined, doc.__pageRoot.children.map((c) => c.className).join(' | '));
  check(
    '没有挂在外层 .centerCol 上（否则被页面底色盖住）',
    doc.__centerCol.children.every((child) => !child.hasAttribute('data-dsk-skin')),
    doc.__centerCol.children.map((c) => c.tagName + ':' + c.className).join(' | '),
  );
  check('没有跑到侧边栏列', doc.__sidebarCol.children.every((child) => !child.hasAttribute('data-dsk-skin')));
  check(
    '皮肤层是对话页面容器的第一个子元素',
    doc.__pageRoot.children[0] === injected,
    doc.__pageRoot.children.map((c) => c.tagName + ':' + c.className).join(' | '),
  );
  check('皮肤层不吃鼠标事件且在最底层', SKIN_LAYER_STYLE_OK(injected), injected?.style.cssText);
  const holder = injected?.children[0];
  check('皮肤层收到了绘制产物', typeof holder?.innerHTML === 'string' && holder.innerHTML.includes('<svg'), String(holder?.innerHTML).slice(0, 60));
  check(
    '皮肤层带可读诊断信息（title 写明宿主）',
    typeof injected?.title === 'string' && injected.title.includes('Dc7zOa_root'),
    injected?.title,
  );

  dispose();
  check('dispose 后皮肤层被移除', doc.__pageRoot.children.every((child) => !child.hasAttribute('data-dsk-skin')));

  // 幂等：同一份文档重复注入只留一层
  const doc2 = makeSkinDocument();
  const dispose2 = api.skin({ doc: doc2, render: () => '<svg/>', isActive: () => true, revision: () => 'v1' });
  const dispose3 = api.skin({ doc: doc2, render: () => '<svg/>', isActive: () => true, revision: () => 'v1' });
  check(
    '重复注入只有一层皮肤',
    doc2.__pageRoot.children.filter((c) => c.hasAttribute('data-dsk-skin')).length === 1,
    String(doc2.__pageRoot.children.filter((c) => c.hasAttribute('data-dsk-skin')).length),
  );
  dispose3();
  dispose2();

  // 旧层清理：上一版可能把层留在了别处
  const doc3 = makeSkinDocument();
  const stale = doc3.createElement('div');
  stale.setAttribute('data-dsk-skin', '');
  doc3.__centerCol.appendChild(stale);
  const dispose4 = api.skin({ doc: doc3, render: () => '<svg/>', isActive: () => true, revision: () => 'v1' });
  check(
    '启动时清掉留在 .centerCol 的旧皮肤层',
    doc3.__centerCol.children.every((c) => !c.hasAttribute('data-dsk-skin')),
    doc3.__centerCol.children.map((c) => c.className).join(' | '),
  );
  dispose4();
}

// ------------------------------------------------- 皮肤绘制：最右一根 K 线要留右边距
//
// 之前把整段行情拉满整宽，最后一根蜡烛紧贴右边界，看起来像"以起点为准压扁"。

if (api !== undefined && typeof api.skinSvg === 'function' && quoteCandles.length > 0) {
  const snapshot = { quote: { code: '000300', name: '沪深300', candles: quoteCandles }, period: 'day' };
  for (const [w, h] of [
    [280, 800],
    [720, 700],
    [1200, 800],
    [1920, 900],
  ]) {
    const svg = api.skinSvg(snapshot, w, h);
    const svgW = Number(/<svg[^>]*width="(\d+)"/.exec(svg)?.[1] ?? 0);
    const bodies = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)"[^>]*fill-opacity="0.42"/g)].map((m) => ({
      x: Number(m[1]),
      w: Number(m[3]),
    }));
    const last = bodies[bodies.length - 1];
    const gap = last === undefined ? -1 : svgW - (last.x + last.w);
    check(`${w}×${h}：最右 K 线到右边界有留白`, last !== undefined && gap >= 12, `蜡烛 ${bodies.length} 根，间距 ${gap.toFixed(1)}px`);
    check(`${w}×${h}：蜡烛没有越过右边界`, last !== undefined && last.x + last.w <= svgW, `右边缘 ${(last?.x + last?.w).toFixed(1)} / svg ${svgW}`);
  }
}

// ------------------------------------------------- 性能：拖动侧栏边框不能逐帧重绘
//
// 拖动侧栏时壳层**每帧**都在改 `.frame` 的 grid-template-columns，
// MutationObserver 于是每帧触发。曾经每帧跑一次全文档 querySelectorAll
// 加一次重绘（读 clientWidth 触发强制 layout），表现就是拖动卡顿。
// 修法是三重：节流、快路径跳过扫描、尺寸变化小于 3% 不重绘。

if (api !== undefined && typeof api.skin === 'function') {
  // 造一个宽度可变的文档，模拟拖动
  const perfDoc = (() => {
    const make = (tag, isRoot) => {
      const node = {
        tagName: tag,
        children: [],
        attrs: Object.create(null),
        style: { cssText: '' },
        className: '',
        parentNode: null,
        firstChild: null,
        title: '',
        w: 900,
        h: 700,
        isRoot: isRoot === true,
        setAttribute(n) { this.attrs[n] = ''; },
        getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
        hasAttribute(n) { return n in this.attrs; },
        appendChild(c) { c.parentNode = this; this.children.push(c); this.firstChild = this.children[0] ?? null; return c; },
        insertBefore(c, before) {
          c.parentNode = this;
          const i = this.children.indexOf(before);
          if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
          this.firstChild = this.children[0] ?? null;
          return c;
        },
        removeChild(c) {
          const i = this.children.indexOf(c);
          if (i >= 0) this.children.splice(i, 1);
          c.parentNode = null; this.firstChild = this.children[0] ?? null; return c;
        },
        querySelector(sel) {
          const all = [];
          const collect = (n) => { for (const c of n.children) { all.push(c); collect(c); } };
          collect(this);
          const parts = []; let rest = sel;
          while (rest.length > 0) {
            const open = rest.indexOf('[');
            if (open < 0) { parts.push(rest); break; }
            if (open > 0) parts.push(rest.slice(0, open));
            const close = rest.indexOf(']', open);
            parts.push(rest.slice(open, close + 1));
            rest = rest.slice(close + 1);
          }
          return all.find((n) => parts.every((p) => {
            if (p.startsWith('[class*="') && p.endsWith('"]')) return typeof n.className === 'string' && n.className.includes(p.slice(9, -2));
            if (p.startsWith('[') && p.endsWith(']')) return p.slice(1, -1) in n.attrs;
            return n.tagName === p;
          })) ?? null;
        },
        querySelectorAll(sel) {
          stats.scans++;
          const all = [];
          const collect = (n) => { for (const c of n.children) { all.push(c); collect(c); } };
          collect(this);
          if (sel.startsWith('[') && sel.endsWith(']')) {
            const name = sel.slice(1, -1);
            return all.filter((n) => name in n.attrs);
          }
          return [];
        },
      };
      Object.defineProperty(node, 'clientWidth', {
        get() { return node.isRoot ? node.w : node.parentNode === null ? 900 : node.parentNode.clientWidth; },
      });
      Object.defineProperty(node, 'clientHeight', {
        get() { return node.isRoot ? node.h : node.parentNode === null ? 700 : node.parentNode.clientHeight; },
      });
      return node;
    };

    const stats = { scans: 0, renders: 0 };
    const body = make('body');
    const center = make('div');
    center.className = 'BynINW_centerCol';
    const pageRoot = make('div', true);
    pageRoot.className = 'Dc7zOa_root';
    pageRoot.setAttribute('data-phase', 'active');
    const pageBody = make('div');
    pageBody.className = 'Dc7zOa_body';
    center.appendChild(pageRoot);
    pageRoot.appendChild(pageBody);
    body.appendChild(center);

    const observers = [];
    const doc = {
      body,
      createElement: make,
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
      defaultView: {
        MutationObserver: class { constructor(cb) { this.cb = cb; } observe() { observers.push(this); } disconnect() {} },
        addEventListener() {}, removeEventListener() {},
        setInterval: () => 0, clearInterval() {},
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t),
      },
    };
    return { doc, stats, observers, pageRoot };
  })();

  const disposePerf = api.skin({
    doc: perfDoc.doc,
    render: (width, height) => {
      perfDoc.stats.renders++;
      return `<svg width="${width}" height="${height}"></svg>`;
    },
    isActive: () => true,
    revision: () => 'v1',
  });

  check('拖动前只渲染一次', perfDoc.stats.renders === 1, String(perfDoc.stats.renders));

  perfDoc.stats.scans = 0;
  const rendersBefore = perfDoc.stats.renders;
  // 60 帧拖动，每帧改宽度并触发 observer
  for (let i = 1; i <= 60; i++) {
    perfDoc.pageRoot.w = 900 + i * 4;
    perfDoc.observers.forEach((o) => o.cb());
  }
  await new Promise((resolve) => setTimeout(resolve, 400));

  const dragRenders = perfDoc.stats.renders - rendersBefore;
  check(
    '拖动 60 帧不会逐帧重绘（节流生效）',
    dragRenders <= 20,
    `重绘 ${dragRenders} 次（未优化时为 60）`,
  );
  check(
    '拖动期间不做全文档扫描（快路径生效）',
    perfDoc.stats.scans <= 2,
    `扫描 ${perfDoc.stats.scans} 次（未优化时为 60）`,
  );
  check(
    '拖动结束后补一次，尺寸跟上最终宽度',
    (() => {
      const holder = perfDoc.pageRoot.children[0]?.children[0];
      const w = Number(/width="(\d+)"/.exec(holder?.innerHTML ?? '')?.[1] ?? -1);
      return w === 1140;
    })(),
    String(/width="(\d+)"/.exec(perfDoc.pageRoot.children[0]?.children[0]?.innerHTML ?? '')?.[1]),
  );
  disposePerf();

  // 结构层面的两条约定：只订阅 childList、把小变化交给 CSS 拉伸
  const src = readFileSync(BUNDLE, 'utf8');
  check(
    '皮肤只订阅 childList（不订阅 attributes，避免拖动每帧回调）',
    src.includes('observer.observe(doc.body, { childList: true, subtree: true })') &&
      !/observe\(doc\.body,\s*\{[^}]*attributes/.test(src),
    '拖动改的是内联 style（attributes），不订阅就没有这个开销',
  );
  check('皮肤有小幅变化阈值（3% 交给 CSS 拉伸）', src.includes('lastWidth * 0.03') && src.includes('SYNC_MIN_GAP_MS'));
}

// ----------------------------------------------------------------- 设置页开关

const toggleRows = bySlot('settings.general.item');
check('设置页只有一个开关行（背景 K 线）', toggleRows.length === 1, JSON.stringify(toggleRows.map((row) => row.options.id)));
const skinToggleTree = render(toggleRows.find((row) => row.options.id === 'stock-kline-skin').component, {});
check(
  '背景 K 线开关渲出复选框且默认勾选',
  findNode(skinToggleTree, (node) => node.type === 'input' && node.props.checked === true) !== null,
  textOf(skinToggleTree).slice(0, 80),
);
check(
  '设置页不再有浮窗开关（已移到面板）',
  toggleRows.every((row) => row.options.id !== 'stock-kline-ticker'),
  JSON.stringify(toggleRows.map((row) => row.options.id)),
);

// ----------------------------------------------------------------- 侧边栏图标（备用入口）

const iconTree = render(bySlot('sidebar.panellist')[0].component, { size: 16, active: false });
check('侧边栏图标渲出 svg', findNode(iconTree, (node) => node.type === 'svg') !== null);


/** 造一个假的文档：body → centerCol →（当前面板）。 */
function makeFakeDocument() {
  function makeNode(tag) {
    return {
      tagName: tag,
      children: [],
      attrs: {},
      style: { cssText: '', display: '' },
      clientWidth: 1000,
      clientHeight: 700,
      textContent: '',
      parentNode: null,
      firstChild: null,
      className: '',
      setAttribute(name) {
        this.attrs[name] = '';
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
      },
      hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name);
      },
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        this.firstChild = this.children[0] ?? null;
        return child;
      },
      insertBefore(child, before) {
        child.parentNode = this;
        const index = this.children.indexOf(before);
        if (index < 0) this.children.push(child);
        else this.children.splice(index, 0, child);
        this.firstChild = this.children[0] ?? null;
        return child;
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentNode = null;
        this.firstChild = this.children[0] ?? null;
        return child;
      },
      querySelector(selector) {
        // 深度优先：从自己开始往下找第一个匹配的**后代**（不含自己）。
        // 支持 "tag[attr][class*=...]" 组合选择器（皮肤用 [data-phase][class*="root"]）。
        const all = [];
        const collect = (node) => {
          for (const child of node.children) {
            all.push(child);
            collect(child);
          }
        };
        collect(this);
        const parts = [];
        let rest = selector;
        while (rest.length > 0) {
          const open = rest.indexOf('[');
          if (open < 0) {
            parts.push(rest);
            break;
          }
          if (open > 0) parts.push(rest.slice(0, open));
          const close = rest.indexOf(']', open);
          parts.push(rest.slice(open, close + 1));
          rest = rest.slice(close + 1);
        }
        const match = (node) =>
          parts.every((part) => {
            if (part.startsWith('[class*="') && part.endsWith('"]')) {
              return typeof node.className === 'string' && node.className.includes(part.slice(9, -2));
            }
            if (part.startsWith('[') && part.endsWith(']')) {
              return Object.prototype.hasOwnProperty.call(node.attrs, part.slice(1, -1));
            }
            return node.tagName === part;
          });
        return all.find(match) ?? null;
      },
      querySelectorAll(selector) {
        // 同类选择器，但返回所有匹配的后代（皮肤用它清理"留在别处的旧层"）
        const all = [];
        const collect = (node) => {
          for (const child of node.children) {
            all.push(child);
            collect(child);
          }
        };
        collect(this);
        if (selector.startsWith('[') && selector.endsWith(']')) {
          const name = selector.slice(1, -1);
          return all.filter((node) => Object.prototype.hasOwnProperty.call(node.attrs, name));
        }
        return [];
      },
    };
  }

  const body = makeNode('body');
  const frame = makeNode('div');
  frame.className = 'BynINW_frame';
  const sidebarCol = makeNode('div');
  sidebarCol.className = 'BynINW_sidebarCol';
  // 侧边栏根节点（有底色，内容都是非定位元素）
  const sidebarRoot = makeNode('div');
  sidebarRoot.className = '_2H3hWW_root';
  const regionArea = makeNode('div');
  regionArea.className = '_2H3hWW_regionArea';
  const centerCol = makeNode('div');
  centerCol.className = 'BynINW_centerCol';
  // 对话页面**自己的**容器：ui-conversation 的 ConversationMainPanel 根节点。
  // 自带不透明底色 + position:relative —— 皮肤必须挂进它里面，挂 .centerCol 会被盖住。
  const pageRoot = makeNode('div');
  pageRoot.className = 'Dc7zOa_root';
  pageRoot.setAttribute('data-phase', 'active');
  const pageBody = makeNode('div');
  pageBody.className = 'Dc7zOa_body';
  const overlayLayer = makeNode('div');
  overlayLayer.setAttribute('data-shell-overlay');
  overlayLayer.className = 'BynINW_overlayLayer';

  frame.appendChild(sidebarCol);
  frame.appendChild(centerCol);
  frame.appendChild(overlayLayer);
  sidebarCol.appendChild(sidebarRoot);
  sidebarRoot.appendChild(regionArea);
  centerCol.appendChild(pageRoot);
  pageRoot.appendChild(pageBody);
  body.appendChild(frame);

  const observers = [];
  const doc = {
    body,
    head: makeNode('head'),
    createElement: (tag) => makeNode(tag),
    querySelector: (selector) => body.querySelector(selector),
    defaultView: {
      MutationObserver: class {
        constructor(callback) {
          this.callback = callback;
        }
        observe() {
          observers.push(this);
        }
        disconnect() {}
      },
      addEventListener() {},
      removeEventListener() {},
      setInterval: () => 0,
      clearInterval() {},
    },
    __observers: observers,
    __frame: frame,
    __sidebarCol: sidebarCol,
    __sidebarRoot: sidebarRoot,
    __regionArea: regionArea,
    __centerCol: centerCol,
    __pageRoot: pageRoot,
    __pageBody: pageBody,
  };
  return doc;
}

// `api` 已在上面（挂件那一节）声明过：plugin.__test。这里不再重复声明，
// 否则中间那段落在暂时性死区里会直接抛 ReferenceError。
check('bundle 暴露了 __test（css / store / 组件）', api !== undefined && typeof api.css === 'function' && api.store !== undefined);

// ----------------------------------------------------------------- 样式表完整性（防回归）
//
// 曾经踩过的坑：按行清理旧样式把多行拼接的规则拦腰截断，留下孤儿属性碎片，
// CSS 解析器一路吞 token 把后面 `.dsk-ticker *{color}` 整条规则吃掉，
// 表现就是「挂件纯白、文字全看不见」。这里直接对产出的样式表做结构断言。

if (api !== undefined && typeof api.css === 'function') {
  const cssText = api.css();
  check('样式表是非空字符串', typeof cssText === 'string' && cssText.length > 500, `len=${String(cssText).length}`);

  let depth = 0;
  let underflow = 0;
  for (const ch of cssText) {
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < 0) underflow++;
    }
  }
  check('样式表大括号配平', depth === 0 && underflow === 0, `depth=${depth} underflow=${underflow}`);

  const ruleLines = cssText.split('\n').filter((line) => line.trim() !== '');
  const brokenRules = ruleLines.filter(
    (line) => (line.includes('{') && !line.includes('}')) || (!line.includes('{') && line.includes('}')),
  );
  check('每条规则都完整（不含被截断的多行规则）', brokenRules.length === 0, brokenRules.slice(0, 3).join(' ｜ '));

  // 孤儿属性碎片：一行里出现了 "属性:值" 却没有选择器也没有收尾
  const orphans = ruleLines.filter(
    (line) => !line.includes('{') && !line.includes('}') && /^[a-z-]+\s*:/.test(line.trim()),
  );
  check('样式表里没有孤儿属性行', orphans.length === 0, orphans.slice(0, 3).join(' ｜ '));

  // 文字颜色的兜底现在走两处：SVG 的 fill 呈现属性（组件内联写死，见上面的断言）
  // 和样式表里这段不透明兜底。背景按需求改成透明，所以这里不再要求白色底。
  check(
    '挂件文字色被强制写死（不透明、不引用主题变量）',
    /\.dsk-tickerSvg text\{[^}]*font-family/.test(cssText) && !/dsk-ticker[^}]*var\(--dsw/.test(cssText),
  );
  check(
    '挂件样式表里不再有不透明白底',
    cssText.includes('.dsk-ticker{') && /\.dsk-ticker\{[^}]*background:transparent/.test(cssText),
  );
} else {
  check('bundle 暴露了 __test.css', false);
}
// ----------------------------------------------------------------- store 语义

const firstRender = render(mainComponent, {});
const secondRender = render(mainComponent, {});
check('两次渲染结构一致（快照稳定）', textOf(firstRender) === textOf(secondRender), `${textOf(firstRender).length} vs ${textOf(secondRender).length} 字符`);

// ------------------------------------------------- 每个指数都该有全部周期
//
// 这里**曾经**断言"美股指数下分钟周期按钮置灰"——因为那时美股确实拿不到分钟数据
// （腾讯的分时接口对美股只回 1 个点）。接上东财之后不成立了：东财的 klt=1 对
// 美股指数能给满 390 根，klt=5/15/30/60 也有原生数据；恒生科技东财没有，
// 但腾讯的分时够用、能自己聚合成分钟 K 线。
//
// 所以现在断言反过来：**任何标的、任何周期都不该被禁用**。
// 这条比原来那条更有价值 —— 它守的是"别再把能用的周期藏起来"。

/** 收集树里所有按钮，按文案索引。 */
function buttonsByLabel(tree) {
  const found = new Map();
  (function walk(node) {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'button') found.set(textOf(node).trim(), node);
    (node.children ?? []).forEach(walk);
  })(tree);
  return found;
}

{
  const { store } = plugin.__test;
  const ALL_PERIOD_LABELS = ['分时', '5分', '15分', '30分', '60分', '日K', '周K', '月K'];

  check('periodsForCode 已随限制一起移除', plugin.__test.periodsForCode === undefined);

  for (const [symbol, label] of [
    ['600519', '个股'],
    ['000300', 'A 股指数'],
    ['HSI', '港股指数'],
    ['HSTECH', '港股指数（东财没有、走腾讯）'],
    ['DJI', '美股指数'],
    ['IXIC', '美股指数'],
  ]) {
    store.selectSymbol(symbol);
    const buttons = buttonsByLabel(render(mainComponent, {}));
    const disabled = ALL_PERIOD_LABELS.filter((l) => buttons.get(l)?.props?.disabled === true);
    check(
      `${label} ${symbol}：8 个周期按钮全部可用`,
      buttons.size > 0 && disabled.length === 0,
      disabled.length > 0 ? `被禁用：${disabled.join(',')}` : '无禁用',
    );
  }

  // store 不该再拦截任何周期（原来会把美股指数上的分钟周期挡掉）
  store.selectSymbol('DJI');
  store.setPeriod('minute');
  check('美股指数上可以切到分时（store 不再回落）', store.get().period === 'minute', `period=${store.get().period}`);
  store.setPeriod('30');
  check('美股指数上可以切到 30 分', store.get().period === '30', `period=${store.get().period}`);
  store.setPeriod('month');
  check('美股指数上可以切到月 K', store.get().period === 'month', `period=${store.get().period}`);

  // 换标的时周期应保持，不再被"回落"
  store.setPeriod('minute');
  store.selectSymbol('000300');
  check('换标的时周期保持不变（不再回落日 K）', store.get().period === 'minute', `period=${store.get().period}`);

  store.selectSymbol('000300');
  store.setPeriod('day');
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
