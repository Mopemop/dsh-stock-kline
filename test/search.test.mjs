/**
 * 搜索框联想测试（"输入时总显示没有匹配"的回归）
 *
 * ## 为什么要单独一个文件
 *
 * 主测试台（client-render.test.mjs）测不了这个：
 *   · 它每次 `render()` 都重置 hook 槽位，异步 `setState` 落不下来；
 *   · 它的 `useEffect` 桩忽略依赖数组，永远只在首见时排队 ——
 *     而搜索的核心恰恰是"`query` 变了要重新发请求"。
 * 所以这里用一套带**依赖比较**、且状态跨渲染保留的最小 harness。
 *
 * ## 守的是什么
 *
 * 曾经的 bug：没有"请求进行中"这个概念，`items` 在路上时就是空数组，
 * 下拉里立刻显示「没有匹配（回车按输入尝试）」—— 用户看到的就是"输入时总显示没有匹配"。
 * 现在必须区分：loading → 「搜索中…」；done 且空 → 才说「没有匹配」。
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

const reactStub = {
  createElement: h,
  useState(init) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    if (!(index in store.slots)) store.slots[index] = typeof init === 'function' ? init() : init;
    return [
      store.slots[index],
      (next) => {
        const value = typeof next === 'function' ? next(store.slots[index]) : next;
        store.slots[index] = value;
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
  /** 带依赖比较：依赖变了才重跑（搜索的 query 依赖靠它）。 */
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
  useSyncExternalStore(subscribe, getSnapshot) {
    const store = hooksFor(currentComponent);
    const index = hookCursor++;
    if (!(index in store.slots)) store.slots[index] = getSnapshot();
    return store.slots[index];
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

/**
 * 渲染 + flush effect + **再渲染一遍**。
 *
 * ⚠️ 最后那一步不能省：effect 里 `setState` 的结果要下一次渲染才可见，
 * 就像真实 React 那样。少了它读到的是 effect 执行**之前**的树 ——
 * 第一版 harness 就漏了这步，断言全都在看旧状态。
 */
function pass(component, props) {
  const tree = expand({ type: component, props: props ?? {}, children: [] });
  const queued = pendingEffects.splice(0, pendingEffects.length);
  for (const item of queued) {
    const cleanup = item.effect();
    const slot = item.store.slots[item.key];
    if (slot !== undefined && typeof cleanup === 'function') slot.cleanup = cleanup;
  }
  // effect 里可能又排队了新 effect（依赖变化）；一并 flush 后再取树
  const again = pendingEffects.splice(0, pendingEffects.length);
  for (const item of again) {
    const cleanup = item.effect();
    const slot = item.store.slots[item.key];
    if (slot !== undefined && typeof cleanup === 'function') slot.cleanup = cleanup;
  }
  return expand({ type: component, props: props ?? {}, children: [] });
}

/** 模拟"状态更新后重新渲染"。 */
function rerender(component, props) {
  return pass(component, props);
}

// ----------------------------------------------------------------- 环境桩

let fetchCalls = [];
let fetchMode = 'items';
let fetchItems = [];
let fetchResolvers = [];

const fakeFetch = (url) => {
  const text = String(url);
  fetchCalls.push(text);
  if (!text.includes('/api/search')) {
    // 其他请求（hydrate / quote）一律给个空壳，测试不关心
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ prefs: {} }) });
  }
  return new Promise((resolve) => {
    fetchResolvers.push(() => {
      resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            fetchMode === 'items' ? { items: fetchItems, query: 'q' } : { items: [], query: 'q' },
          ),
      });
    });
  });
};

globalThis.fetch = fakeFetch;

const fakeWindow = {
  __ModuleLoader__: { load: (r) => (fakeWindow.__reg = r) },
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1600,
  innerHeight: 900,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 0,
  clearInterval() {},
  requestAnimationFrame: (fn) => {
    fn(0);
    return 0;
  },
  cancelAnimationFrame() {},
};
globalThis.window = fakeWindow;
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  head: { appendChild() {} },
  createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
  querySelector: () => null,
};
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
const plugin = fakeWindow.__reg.factory(requireStub);
const SymbolSearch = plugin.__test.SymbolSearch;

// ----------------------------------------------------------------- 工具

const findByClass = (node, cls) =>
  (function walk(n) {
    if (n === null || n === undefined || typeof n !== 'object') return null;
    if (Array.isArray(n)) {
      for (const c of n) {
        const hit = walk(c);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls)) return n;
    for (const c of n.children ?? []) {
      const hit = walk(c);
      if (hit !== null) return hit;
    }
    return null;
  })(node);

const findInput = (node) =>
  (function walk(n) {
    if (n === null || n === undefined || typeof n !== 'object') return null;
    if (Array.isArray(n)) {
      for (const c of n) {
        const hit = walk(c);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (n.type === 'input') return n;
    for (const c of n.children ?? []) {
      const hit = walk(c);
      if (hit !== null) return hit;
    }
    return null;
  })(node);

const textOf = (n) => {
  if (n === null || n === undefined) return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(' ');
  return (n.children ?? []).map(textOf).join(' ');
};

const menuText = (tree) => {
  const menu = findByClass(tree, 'dsk-menu');
  return menu === null ? '' : textOf(menu).replace(/\s+/g, ' ').trim();
};

const menuButtons = (tree) => {
  const menu = findByClass(tree, 'dsk-menu');
  const out = [];
  (function walk(n) {
    if (n === null || n === undefined || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'button') out.push(n);
    (n.children ?? []).forEach(walk);
  })(menu);
  return out;
};

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('搜索框联想\n');

// ----------------------------------------------------------------- 断言

let picked = [];
const props = { current: '000300', onPick: (v) => picked.push(v) };

// 1) 聚焦但没输入 → 给输入提示，不说"没有匹配"
{
  let tree = pass(SymbolSearch, props);
  const input = findInput(tree);
  input.props.onFocus();
  tree = rerender(SymbolSearch, props);
  const text = menuText(tree);
  check('聚焦未输入时给出输入提示', text.includes('输入代码或名称'), text || '(空)');
  check('聚焦未输入时不说"没有匹配"', !text.includes('没有匹配'), text);
}

// 2) 输入后立刻应该是「搜索中…」，而不是「没有匹配」  ← 这条就是用户报的 bug
{
  let tree = rerender(SymbolSearch, props);
  const input = findInput(tree);
  input.props.onChange({ target: { value: '600519' } });
  tree = rerender(SymbolSearch, props);
  const text = menuText(tree);
  check('输入后立刻显示「搜索中…」', text.includes('搜索中'), text || '(空)');
  check(
    '输入后立刻**不**显示「没有匹配」',
    !text.includes('没有匹配'),
    text || '(空)',
  );
}

// 3) 等防抖 + 请求返回结果
fetchItems = [
  { code: '600519', name: '贵州茅台', prefix: 'sh' },
  { code: '600520', name: '文一科技', prefix: 'sh' },
];
{
  await settle(200); // 越过 120ms 防抖，让 fetch 发出
  const calls = fetchCalls.filter((u) => u.includes('/api/search'));
  check('防抖后发出搜索请求', calls.length === 1, JSON.stringify(calls));
  check('请求带上了输入的关键词', calls[0] !== undefined && calls[0].includes('q=600519'), calls[0]);
  // 手动让请求完成
  fetchResolvers.forEach((fn) => fn());
  await settle(30);
  const tree = rerender(SymbolSearch, props);
  const text = menuText(tree);
  check('结果返回后列出候选', text.includes('贵州茅台'), text || '(空)');
  check('候选带代码后缀', text.includes('600519.SH'), text);
  check('有结果时不再显示 loading/没有匹配', !text.includes('搜索中') && !text.includes('没有匹配'), text);
  const btns = menuButtons(tree);
  check('候选是可点击按钮', btns.length >= 2, `${btns.length} 个按钮`);
}

// 4) 点候选 → onPick(代码)
{
  const tree = rerender(SymbolSearch, props);
  const btns = menuButtons(tree);
  const maotai = btns.find((b) => textOf(b).includes('贵州茅台'));
  check('找到贵州茅台候选', maotai !== undefined);
  picked = [];
  maotai.props.onClick();
  check('点候选回传股票代码', picked.length === 1 && picked[0] === '600519', JSON.stringify(picked));
}

// 5) 无结果时，只有在请求**结束后**才说「没有匹配」
{
  fetchCalls = [];
  fetchResolvers = [];
  fetchMode = 'empty';
  let tree = rerender(SymbolSearch, props);
  const input = findInput(tree);
  input.props.onChange({ target: { value: 'zzzz' } });
  tree = rerender(SymbolSearch, props);
  check('新关键词下立刻清掉上一轮结果（不显示别的股票）', !menuText(tree).includes('贵州茅台'), menuText(tree));
  check('新关键词下显示「搜索中…」', menuText(tree).includes('搜索中'), menuText(tree));
  await settle(200);
  fetchResolvers.forEach((fn) => fn());
  await settle(30);
  tree = rerender(SymbolSearch, props);
  check('请求结束且确实无结果 → 才说「没有匹配」', menuText(tree).includes('没有匹配'), menuText(tree));
}

// 6) 「直接查询」兜底行：以前只有回车能触发，用户不知道
{
  const tree = rerender(SymbolSearch, props);
  const btns = menuButtons(tree);
  const direct = btns.find((b) => textOf(b).includes('直接查询'));
  check('无精确同码时给出「直接查询」入口', direct !== undefined, menuText(tree));
  if (direct !== undefined) {
    picked = [];
    direct.props.onClick();
    check('点「直接查询」回传输入内容', picked.length === 1 && picked[0] === 'zzzz', JSON.stringify(picked));
  }
}

// 7) 键盘：↑/↓ 高亮 + Enter 选中高亮项
{
  fetchCalls = [];
  fetchResolvers = [];
  fetchMode = 'items';
  fetchItems = [
    { code: '600519', name: '贵州茅台', prefix: 'sh' },
    { code: '600520', name: '文一科技', prefix: 'sh' },
  ];
  let tree = rerender(SymbolSearch, props);
  const input = findInput(tree);
  input.props.onChange({ target: { value: '6005' } });
  tree = rerender(SymbolSearch, props);
  await settle(200);
  fetchResolvers.forEach((fn) => fn());
  await settle(30);
  tree = rerender(SymbolSearch, props);

  const input2 = findInput(tree);
  input2.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  tree = rerender(SymbolSearch, props);
  const activeRow = menuButtons(tree).find((b) => b.props['data-active'] === '1');
  check('↓ 能高亮第一项', activeRow !== undefined && textOf(activeRow).includes('贵州茅台'), menuText(tree));

  picked = [];
  findInput(tree).props.onKeyDown({ key: 'Enter', preventDefault() {} });
  check('Enter 选中高亮项（而不是直接查输入）', picked.length === 1 && picked[0] === '600519', JSON.stringify(picked));
}

// 8) 没有高亮时，Enter 直接查输入内容
{
  let tree = rerender(SymbolSearch, props);
  const input = findInput(tree);
  input.props.onChange({ target: { value: '300750' } });
  tree = rerender(SymbolSearch, props);
  picked = [];
  findInput(tree).props.onKeyDown({ key: 'Enter', preventDefault() {} });
  check('无高亮时 Enter 直接查输入', picked.length === 1 && picked[0] === '300750', JSON.stringify(picked));
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
