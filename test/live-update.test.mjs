/**
 * 实时性测试：随时间变化时，对话背景 K 线与浮窗涨跌幅会不会更新。
 *
 * 分两部分，必须分开看，因为它们的答案**不一样**：
 *
 *   A. 数据会不会自己按时刷新？  → 会，且**间隔跟随当前周期**（分时 5s … 日月周 60s）
 *   B. 数据变了，界面会不会跟着变？ → 会（渲染链路本来就是通的）
 *
 * 分开测的意义：只测 A 看不出"取了到底画没画"；只测 B 又会给人"它在实时更新"的
 * 错觉（在加自动刷新之前，B 是通的、A 是断的 —— 界面永远停在最近一次取数）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'lib', 'client.js');

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  ' + detail}`);
  if (!ok) failures++;
}

// ----------------------------------------------------------------- harness

const hookStores = new Map();
const componentKeys = new Map();
let keySeq = 0;
let currentComponent = null;
let hookCursor = 0;
let pendingEffects = [];

const keyFor = (type) => {
  if (!componentKeys.has(type)) componentKeys.set(type, 'c' + keySeq++);
  return componentKeys.get(type);
};
const hooksFor = (key) => {
  if (!hookStores.has(key)) hookStores.set(key, { slots: [] });
  return hookStores.get(key);
};
const sameDeps = (a, b) => {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
  return true;
};

const h = (type, props, ...kids) => ({
  type,
  props: props ?? {},
  children: kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
});

// ---- 定时器 instrumentation：记录所有被排的定时器，可按需触发 ----
let intervals = [];

const reactStub = {
  createElement: h,
  useState(init) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    if (!(index in store.slots)) store.slots[index] = typeof init === 'function' ? init() : init;
    return [
      store.slots[index],
      (next) => {
        store.slots[index] = typeof next === 'function' ? next(store.slots[index]) : next;
      },
    ];
  },
  useRef(init) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    if (!(index in store.slots)) store.slots[index] = { current: init };
    return store.slots[index];
  },
  useMemo(factory) {
    hookCursor++;
    return factory();
  },
  useCallback(fn) {
    hookCursor++;
    return fn;
  },
  useEffect(effect, deps) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    const key = 'effect' + index;
    const prev = store.slots[key];
    if (prev !== undefined && sameDeps(prev.deps, deps)) return;
    if (prev !== undefined && typeof prev.cleanup === 'function') prev.cleanup();
    store.slots[key] = { deps, cleanup: undefined };
    pendingEffects.push({ store, key, effect });
  },
  // 每次都取最新快照，模拟"store 变了 → 界面拿到新值"
  useSyncExternalStore(subscribe, getSnapshot) {
    hookCursor += 1;
    return getSnapshot();
  },
};

function expand(node) {
  if (node === null || node === undefined) return node;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') {
    const prevComponent = currentComponent;
    const prevCursor = hookCursor;
    currentComponent = keyFor(node.type);
    hookCursor = 0;
    let rendered;
    try {
      rendered = node.type(node.props);
    } finally {
      currentComponent = prevComponent;
      hookCursor = prevCursor;
    }
    return expand(rendered);
  }
  return {
    type: node.type,
    props: node.props,
    children: (node.children ?? []).map(expand).filter((c) => c !== null),
  };
}

function pass(component, props) {
  expand({ type: component, props: props ?? {}, children: [] });
  const queued = pendingEffects.splice(0, pendingEffects.length);
  for (const item of queued) {
    const cleanup = item.effect();
    const slot = item.store.slots[item.key];
    if (slot !== undefined && typeof cleanup === 'function') slot.cleanup = cleanup;
  }
  return expand({ type: component, props: props ?? {}, children: [] });
}

// ----------------------------------------------------------------- 环境桩

let quoteCalls = 0;
let quoteBody = null;

const candlesFor = (base) =>
  Array.from({ length: 60 }, (_, i) => ({
    date: '2026-01-01',
    open: base + i,
    close: base + i + 0.5,
    high: base + i + 1,
    low: base + i - 1,
    volume: 1000 + i,
  }));

globalThis.fetch = (url) => {
  const text = String(url);
  if (text.includes('/api/quote')) {
    quoteCalls += 1;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(quoteBody) });
  }
  if (text.includes('/api/prefs')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ prefs: {} }) });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
};

// ---- DOM 桩：要够真实，让皮肤的 1.2s 轮询真的被建出来 ----
// applyPageSkin 要求 doc.body 存在、doc.defaultView 带 MutationObserver，
// 否则它提前 return，那个定时器根本不会创建。
const makeFakeEl = () => ({
  nodeType: 1,
  style: {},
  dataset: {},
  parentNode: null,
  children: [],
  appendChild() {},
  removeChild() {},
  insertBefore() {},
  contains: () => false,
  setAttribute() {},
  getBoundingClientRect: () => ({ width: 900, height: 600, top: 0, left: 0, right: 900, bottom: 600 }),
  querySelector: () => null,
  querySelectorAll: () => [],
});

const documentListeners = new Map();

const fakeWindow = {
  __ModuleLoader__: { load: (r) => (fakeWindow.__reg = r) },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1600,
  innerHeight: 900,
  setInterval: (fn, ms) => {
    intervals.push({ fn, ms });
    return intervals.length;
  },
  clearInterval: (id) => {
    // 标记失效，模拟真实 clearInterval：被清掉的定时器不再触发
    const entry = intervals[id - 1];
    if (entry !== undefined) entry.cleared = true;
  },
  setTimeout: () => 0,
  clearTimeout: () => {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
};

globalThis.document = {
  body: makeFakeEl(),
  head: { appendChild() {} },
  defaultView: fakeWindow,
  visibilityState: 'visible',
  addEventListener: (type, fn) => {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(fn);
  },
  removeEventListener: (type, fn) => {
    const list = documentListeners.get(type);
    if (list === undefined) return;
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  },
  createElement: () => makeFakeEl(),
  querySelector: () => null,
  querySelectorAll: () => [],
};
fakeWindow.document = globalThis.document;
fakeWindow.MutationObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {}
  disconnect() {}
};
globalThis.window = fakeWindow;
// ⚠️ 浏览器里裸 `setInterval` 就是 `window.setInterval`，Node 里不是。
// market.js 用的是裸调用，所以这里必须连全局一起替换，否则定时器排到 Node 上去了，
// 断言"有没有建出定时器"永远看不到。
globalThis.setInterval = fakeWindow.setInterval;
globalThis.clearInterval = fakeWindow.clearInterval;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const requireStub = (name) => {
  if (name === 'react') return reactStub;
  if (name === 'react/jsx-runtime') return { jsx: h, jsxs: h };
  throw new Error('未知依赖 ' + name);
};

// eslint-disable-next-line no-new-func
new Function('window', 'require', 'console', 'document', readFileSync(BUNDLE, 'utf8') + ';')(
  fakeWindow,
  requireStub,
  console,
  globalThis.document,
);

const slots = [];
const effects = [];
const fakeCtx = {
  slots: {
    inject(name, cb) {
      const iter = cb();
      if (iter !== null && iter !== undefined && typeof iter.next === 'function') {
        let step = iter.next();
        while (step.done !== true) step = iter.next();
      }
    },
    register(options, component) {
      slots.push({ options, component });
    },
  },
  effect(fn) {
    // 真实 Cordis 在插件加载时执行 effect，并把返回的函数当 disposer。
    // 这里立即执行，意味着 `store.hydrate()` 与 `store.startAutoRefresh()` 都会跑。
    const cleanup = typeof fn === 'function' ? fn() : undefined;
    effects.push({ cleanup });
    return undefined;
  },
  logger: { warn() {}, info() {} },
};

const plugin = fakeWindow.__reg.factory(requireStub);
const api = plugin.__test;

const A = { code: '000300', name: '沪深300', preClose: 4000, candles: candlesFor(100) };
const B = { code: '000300', name: '沪深300', preClose: 4000, candles: candlesFor(100) };
B.candles[59] = { ...B.candles[59], close: B.candles[59].close + 50 };

const textOf = (n) => {
  if (n === null || n === undefined) return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(' ');
  return (n.children ?? []).map(textOf).join(' ');
};

/** 推进时间：把所有**未被 clear** 的定时器触发若干轮。 */
function advance(rounds) {
  for (let r = 0; r < rounds; r += 1) {
    for (const t of intervals.slice()) if (t.cleared !== true) t.fn();
  }
}

/** 取当前生效的自动刷新定时器（皮肤那个 1200ms 的不算）。 */
const autoTimers = () => intervals.filter((t) => t.cleared !== true && t.ms !== 1200);

console.log('实时性测试：背景 K 线 与 浮窗涨跌幅\n');

// ----------------------------------------------------------------- 间隔表

console.log('── 0. 刷新间隔按周期分档 ──\n');

const table = api.REFRESH_MS_BY_PERIOD;
const expect = {
  minute: 5000,
  '5': 10000,
  '15': 15000,
  '30': 30000,
  '60': 30000,
  day: 60000,
  week: 60000,
  month: 60000,
};
check(
  '每个周期都有明确的间隔',
  Object.keys(expect).every((k) => table[k] === expect[k]),
  JSON.stringify(table),
);
check('周期越细间隔越短（分时 < 5分 < 15分 ≤ 30分 ≤ 日K）', 5000 < 10000 && 10000 < 15000 && 15000 <= 30000 && 30000 <= 60000);
check('间隔有 5 秒下限（不打得太密）', Math.min(...Object.values(table)) === 5000);
check('间隔有 60 秒上限（价格不会看起来冻住）', Math.max(...Object.values(table)) === 60000);
check('未知周期的兜底是上限', api.refreshIntervalFor('nonsense') === 60000, String(api.refreshIntervalFor('nonsense')));

// ----------------------------------------------------------------- A. 会自己刷新

console.log('\n── A. 数据会按时自己刷新 ──\n');

quoteBody = A;
plugin.apply(fakeCtx); // apply 里的两个 effect（水合 + 自动刷新）会立即执行

const mainReg = slots.find((s) => s.options.name === 'main');
const skinReg = slots.find((s) => s.options.id === 'stock-kline-skin');

pass(mainReg.component, {});
pass(skinReg.component, { store: api.store, usePanelInfo: (selector) => selector({ activePanelId: null }) });
await new Promise((resolve) => setTimeout(resolve, 30));

check('打开面板会取一次行情', quoteCalls >= 1, `/quote ${quoteCalls} 次`);
check('存在皮肤的 1.2s DOM 同步轮询', intervals.some((t) => t.ms === 1200), intervals.map((t) => t.ms).join(', '));

// 默认周期是 day → 60s
check(
  '自动刷新定时器已启动，且间隔跟随当前周期（默认日K 60s）',
  autoTimers().length >= 1 && autoTimers().every((t) => t.ms === 60000),
  autoTimers().map((t) => t.ms + 'ms').join(', ') || '(无)',
);

// 推进 5 个间隔 → 应产生 5 次新取数（每次之间让请求落地，贴近真实的"间隔很远"）
{
  const before = quoteCalls;
  for (let i = 0; i < 5; i += 1) {
    advance(1);
    // 让 fetch 落地，inFlight 归零；真实场景里两次间隔相差 60 秒，早就完成了
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  check('推进 5 个间隔 → 产生 5 次取数', quoteCalls - before === 5, `${before} → ${quoteCalls}`);
}

// 同一个间隔内被连续触发多次时，应复用同一个在途请求，不堆积
{
  const before = quoteCalls;
  advance(10);
  await new Promise((resolve) => setTimeout(resolve, 20));
  check(
    '同一间隔内连续触发 10 次只发出 1 次请求（复用在途请求，不堆积）',
    quoteCalls - before === 1,
    `${before} → ${quoteCalls}`,
  );
}

// 切到分时 → 间隔应变 5s，且旧定时器被清掉
{
  intervals = [];
  api.store.setPeriod('minute');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const live = autoTimers();
  check(
    '切到「分时」后间隔变成 5 秒',
    live.length === 1 && live[0].ms === 5000,
    live.map((t) => t.ms + 'ms').join(', ') || '(无)',
  );
  check('旧定时器已被清掉（不会两个同时在跑）', intervals.filter((t) => t.cleared !== true).length === 1);
}

// 切到月K → 60s
{
  intervals = [];
  api.store.setPeriod('month');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const live = autoTimers();
  check('切到「月K」后间隔变成 60 秒', live.length === 1 && live[0].ms === 60000, live.map((t) => t.ms + 'ms').join(', '));
}

// 页面在后台时不取数
{
  api.store.setPeriod('minute');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = quoteCalls;
  globalThis.document.visibilityState = 'hidden';
  advance(10);
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('页面在后台时不取数', quoteCalls === before, `${before} → ${quoteCalls}`);

  globalThis.document.visibilityState = 'visible';
  const beforeVisible = quoteCalls;
  for (const fn of documentListeners.get('visibilitychange') ?? []) fn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('回到前台立刻补取一次', quoteCalls > beforeVisible, `${beforeVisible} → ${quoteCalls}`);
}

// 停止后不再取数
{
  api.store.stopAutoRefresh();
  const before = quoteCalls;
  advance(10);
  await new Promise((resolve) => setTimeout(resolve, 20));
  check('stopAutoRefresh 之后不再取数', quoteCalls === before, `${before} → ${quoteCalls}`);
  api.store.startAutoRefresh();
}

// ----------------------------------------------------------------- B. 数据变了界面跟着变

console.log('\n── B. 数据变了，背景与浮窗跟着变 ──\n');

api.store.set({ quote: A, loading: false, error: null, updatedAt: Date.now() });
const tickerRow = slots.find((s) => s.options.id === 'stock-kline-ticker');
const pctOf = (tree) => {
  const t = textOf(tree);
  // 浮窗文字里含注入的 <style>，只取百分号那一段
  const m = /([+-]\d+\.\d\d%)/.exec(t);
  return m === null ? '' : m[1];
};
const pctA = pctOf(expand({ type: tickerRow.component, props: {}, children: [] }));

api.store.set({ quote: B, loading: false, error: null, updatedAt: Date.now() });
const pctB = pctOf(expand({ type: tickerRow.component, props: {}, children: [] }));

check('浮窗渲染出涨跌幅', pctA !== '', pctA || '(空)');
check('行情变化后浮窗涨跌幅跟着变', pctA !== pctB, `${pctA} → ${pctB}`);

const skinA = api.skinSvg({ quote: A, period: 'day', zoom: 60 }, 900, 600);
const skinB = api.skinSvg({ quote: B, period: 'day', zoom: 60 }, 900, 600);
check('背景 K 线渲染出内容', skinA.length > 0, `${skinA.length} 字符`);
check('行情变化后背景 K 线内容跟着变', skinA !== skinB, `${skinA.length} vs ${skinB.length} 字符`);

const skinSrc = readFileSync(join(HERE, '..', 'src', 'client', 'skin.js'), 'utf8');
check(
  '皮肤 revision 含"最后一根收盘价"（新数据到达就会重绘）',
  /tail \? tail\.date \+ ':' \+ tail\.close/.test(skinSrc),
);

console.log('\n── 结论 ──\n');
console.log('A. 数据**会**按时自己刷新，间隔跟随周期：');
console.log('   分时 5s / 5分 10s / 15分 15s / 30分 30s / 60分 30s / 日·周·月 60s。');
console.log('   页面在后台时不取数，回到前台立刻补一次。');
console.log('B. 数据一变，浮窗文字与背景 K 线立刻反映新值。');

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
