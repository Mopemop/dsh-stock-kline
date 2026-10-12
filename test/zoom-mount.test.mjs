/**
 * 挂载期缩放测试（"回到行情面板时缩放丢失"的回归）
 *
 * ## 为什么单独一个文件
 *
 * 主测试台（client-render.test.mjs）观察不到这个 bug：
 *   · 它的 `useEffect` 桩只在"首次遇到该 hook 索引"时排队，同一组件渲染过一次后
 *     挂载期 effect 就再也不跑；
 *   · 它每次 `render()` 只展开一遍，看不到"挂载期 effect 覆盖 state"的效果。
 * 曾在那里写了一条读渲染树的断言，**把修复回退掉它照样 PASS** —— 假阳性。
 * 所以这里用一套最小的、语义正确的 hook harness：按组件 key 持久化 state，
 * 每次渲染后 flush effect 并再渲染一遍（就像真实 React 那样）。
 *
 * ## 守的是什么
 *
 * `useEffect` 在挂载时必然跑一次。`chart.js` 里那个"换股票/周期重置视野"的 effect
 * 曾无条件把可见根数写回默认 120，于是：
 *   离开面板再回来 → 缩放被重置成 120（丢失）
 *   滚一下轮子   → countRef 里还是正确值，以它为基准缩放 → 画面"跳回"原本缩放
 * 现在受控时 count 取 `props.zoom`，只重置 offset。
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

// ----------------------------------------------------------------- 最小 hook harness

/** 按组件 key 持久化的 hook 槽位（真实 React 的关键语义） */
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

const h = (type, props, ...kids) => ({
  type,
  props: props ?? {},
  children: kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
});

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
  useEffect(effect) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    const key = 'effect' + index;
    if (!(key in store.slots)) {
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
      });
    }
    return store.slots[index];
  },
};

/** 展开函数组件（React 会做这件事）。根组件也走这里，保证 hook 归属正确。 */
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

/** 像真实 React 一样渲染：展开 → flush effect → 再展开一遍 */
function render(component, props) {
  hookStores.delete(keyFor(component)); // 模拟"全新挂载"
  let tree = expand({ type: component, props: props ?? {}, children: [] });
  const queued = pendingEffects.splice(0, pendingEffects.length);
  for (const item of queued) item.store.slots[item.key] = item.effect();
  tree = expand({ type: component, props: props ?? {}, children: [] });
  return tree;
}

// ----------------------------------------------------------------- 环境桩

const fakeWindow = {
  __ModuleLoader__: { load: (r) => (fakeWindow.__reg = r) },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1600,
  innerHeight: 900,
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
  requestAnimationFrame: (fn) => {
    fn(0);
    return 0;
  },
  cancelAnimationFrame() {},
};
globalThis.window = fakeWindow;
globalThis.ResizeObserver = class {
  constructor(cb) {
    this.cb = cb;
  }
  observe() {
    this.cb();
  }
  disconnect() {}
};

const requireStub = (name) => {
  if (name === 'react') return reactStub;
  if (name === 'react/jsx-runtime') return { jsx: h, jsxs: h };
  throw new Error('未知依赖 ' + name);
};

// eslint-disable-next-line no-new-func
new Function('window', 'require', 'console', readFileSync(BUNDLE, 'utf8') + ';')(fakeWindow, requireStub, console);
const plugin = fakeWindow.__reg.factory(requireStub);
const api = plugin.__test;

// ----------------------------------------------------------------- 断言

const candles = Array.from({ length: 240 }, (_, i) => ({
  date: '2026-01-01',
  open: 100 + i,
  close: 100.5 + i,
  high: 101 + i,
  low: 99 + i,
  volume: 1000 + i,
}));
const quote = { symbol: '000300', code: '000300', name: '沪深300', period: 'day', preClose: 100, candles };

const countRects = (node, acc = { n: 0 }) => {
  if (node === null || node === undefined || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    node.forEach((child) => countRects(child, acc));
    return acc;
  }
  if (node.type === 'rect') acc.n += 1;
  (node.children ?? []).forEach((child) => countRects(child, acc));
  return acc;
};
/** 每根 K 线 1 个蜡烛 rect + 1 个成交量 rect */
const barsOf = (node) => Math.round(countRects(node).n / 2);

console.log('挂载期缩放（回到面板不丢缩放）\n');

for (const zoom of [40, 60, 120, 200]) {
  const tree = render(api.KlineChart, {
    quote,
    period: 'day',
    ma: [5, 10, 20],
    height: 420,
    zoom,
    onZoom: () => {},
  });
  const bars = barsOf(tree);
  check(
    `挂载时受控 zoom=${zoom} 生效`,
    Math.abs(bars - zoom) <= 2,
    `实际画了 ${bars} 根（期望 ≈ ${zoom}）`,
  );
}

// 不受控（没传 zoom）时应退回默认根数，而不是崩或画 0 根
{
  const tree = render(api.KlineChart, { quote, period: 'day', ma: [5, 10, 20], height: 420 });
  const bars = barsOf(tree);
  check('不传 zoom 时退回默认根数', bars > 0 && bars <= api.MAX_VISIBLE_BARS, `${bars} 根`);
}

// 越界的受控 zoom 也要被夹住（外部可能给出脏值）
{
  const tooBig = render(api.KlineChart, { quote, period: 'day', ma: [], height: 420, zoom: 9999, onZoom: () => {} });
  const tooSmall = render(api.KlineChart, { quote, period: 'day', ma: [], height: 420, zoom: 1, onZoom: () => {} });
  check('受控 zoom 过大时被夹到上限', barsOf(tooBig) <= api.MAX_VISIBLE_BARS + 2, `${barsOf(tooBig)} 根`);
  check('受控 zoom 过小时被夹到下限', barsOf(tooSmall) >= api.MIN_VISIBLE_BARS - 2, `${barsOf(tooSmall)} 根`);
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
