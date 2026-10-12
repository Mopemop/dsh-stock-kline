/**
 * 构建脚本：把 `src/client/*.js` 合成 DSH 客户端 bundle `lib/client.js`。
 *
 * ## 为什么要构建
 *
 * DSH 的浏览器插件 bundle 由 `/plugins/<pkg>/client.js` **原样**送给页面，
 * 不能有顶层 `import` / `export`（页面侧只是个普通脚本 + `window.__ModuleLoader__`）。
 * 所以源码按模块拆开写，构建时合成一个自包含的单文件：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * ## 模块协议
 *
 * 每个 `src/client/*.js` 都是一段**模块体**（不是独立可执行文件）：
 *   · 不能有顶层 import/export；
 *   · 可以引用本模块内声明的名字，以及构建脚本按 `deps` 注入的依赖名；
 *   · 结尾用 `return { ... }` 导出。
 *
 * 依赖关系写在下面的 MODULES 表里，一眼可见；构建时会校验「声明了却没用」。
 *
 * ## 用法
 *
 *   node scripts/build.mjs            # 生成 lib/client.js
 *   node scripts/build.mjs --check    # 只校验不写文件（测试用）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src', 'client');
const OUT = join(ROOT, 'lib', 'client.js');
const CSS_FILE = join(SRC, 'styles', 'client.css');

/**
 * 平台能力：由 bundle factory 的 require 提供（React 一定在平台种子表里）。
 *
 * ⚠️ `h` 必须是 **createElement**，不能是 `react/jsx-runtime` 的 `jsx`。
 * 两者签名不同：
 *
 *   createElement(type, props, ...children)   ← 源码里用的就是这个语义
 *   jsx(type, props, key)                     ← 第三个参数是 key！
 *
 * 曾经这里填的是 `jsx`，于是所有 `h('div', props, child)` 的**子元素都当 key 丢了**，
 * 表现是"浮窗只剩一个空容器（白框、没有 svg、没有文字）"，而且测试台自带的
 * `makeElement` 是 createElement 语义，一直显示通过 —— 假阳性。
 * 统一用 createElement 后，`props.children` 与第三参数两种写法都能正常渲染。
 */
const PLATFORM = {
  // React 命名空间本身：少数地方需要动态取 hook（例如 useSyncExternalStore 的可用性判断）
  react: "require('react')",
  h: "require('react').createElement",
  useState: "require('react').useState",
  useEffect: "require('react').useEffect",
  useRef: "require('react').useRef",
  useMemo: "require('react').useMemo",
  useCallback: "require('react').useCallback",
  useSyncExternalStore: "require('react').useSyncExternalStore",
};

/** 每个模块对外暴露什么（也用于给消费者生成解构行）。 */
const EXPORTS = {
  format: [
    'fmtPrice',
    'fmtLarge',
    'fmtPct',
    'shortDate',
    'dateLabel',
    'niceTicks',
    'movingAverage',
    'baselineOf',
    'lastClose',
    'UP',
    'DOWN',
    'MA_COLORS',
    'INK',
    'MUTED',
    'HALO',
    // 缩放策略：主面板（chart）与对话背景（skin）共用同一份上下限与夹取，
    // 所以放在 format 这个双方都依赖的共享模块里。
    'MIN_VISIBLE_BARS',
    'MAX_VISIBLE_BARS',
    'DEFAULT_VISIBLE_BARS',
    'ZOOM_STEP',
    'clampVisibleBars',
    'zoomStepsToCount',
  ],
  prefs: ['API', 'LOCAL_KEY', 'PREF_KEYS', 'loadLocalPrefs', 'saveLocalPrefs'],
  indices: ['INDEXES', 'INDEX_GROUPS', 'indexByCode', 'periodsForCode'],
  styles: ['STYLE_TAG', 'cssText', 'getCss', 'installCss'],
  market: ['createStore', 'useStore', 'REFRESH_MS_BY_PERIOD', 'refreshIntervalFor'],
  chart: ['KlineChart'],
  ticker: ['PriceTicker', 'TickerSvg'],
  skin: ['SkinController', 'applyPageSkin', 'renderSkinSvg', 'requestSkinRepaint'],
  'chart-panel': ['SymbolSearch', 'StockPanel'],
  plugin: [],
};

/**
 * 模块清单。顺序 = 初始化顺序，依赖必须排在消费者之前。
 * deps 里的 `@platform` 表示需要 React 能力；其它名字是模块名。
 *
 * `what` 只用于生成产物头部注释 —— 产物里那份模块清单由这里派生，
 * 不再手写（手写过一次，加模块时忘了同步，注释就烂了）。
 */
const MODULES = [
  { name: 'format', file: 'format.js', deps: [], what: '格式化、涨跌色与视觉常量（纯函数）' },
  { name: 'prefs', file: 'prefs.js', deps: [], what: '偏好读写（浏览器本地存储为主，尽力同步宿主）' },
  { name: 'indices', file: 'indices.js', deps: [], what: '常见指数清单（与宿主 lib/indices.js 同源）' },
  { name: 'styles', file: 'styles.js', deps: [], what: '样式注入（CSS 文本在 styles/client.css）' },
  // market 依赖 indices 是为了「周期与标的匹配」：切到美股指数时要把分钟周期
  // 回落到日 K（腾讯对美股指数只提供日/周/月）。依赖 format 则是缩放维度那一套。
  { name: 'market', file: 'market.js', deps: ['@platform', 'prefs', 'format', 'indices'], what: '行情状态中心 store + 订阅 Hook' },
  { name: 'chart', file: 'chart.js', deps: ['@platform', 'format'], what: '自绘 SVG K 线图' },
  { name: 'ticker', file: 'ticker.js', deps: ['@platform', 'format', 'market'], what: '价格挂件（透明小标签：名称 + 涨跌百分比）' },
  { name: 'skin', file: 'skin.js', deps: ['@platform', 'format', 'market'], what: '对话页背景 K 线（DOM 注入）' },
  // chart-panel 依赖 prefs 是为了 `API`（搜索框要拼 /api/search 的地址）。
  // 曾经漏了这条：`API` 成了未定义标识符，搜索请求同步抛错又被 Promise 吞掉，
  // 界面表现是"输入后永远显示没有匹配"。现在由 verifyDeps 的反向检查守着。
  {
    name: 'chart-panel',
    file: 'chart-panel.js',
    deps: ['@platform', 'format', 'chart', 'market', 'indices', 'prefs'],
    what: '行情主面板（指数快捷行 + 整页大图）',
  },
  {
    name: 'plugin',
    file: 'plugin.js',
    deps: ['@platform', 'styles', 'format', 'market', 'indices', 'ticker', 'skin', 'chart', 'chart-panel'],
    what: '插件入口：槽位注册与生命周期',
  },
];

/** 产物头部注释里的模块清单（由 MODULES 生成，宽度按最长模块名对齐）。 */
function moduleListComment() {
  const width = Math.max(...MODULES.map((spec) => spec.file.length));
  return MODULES.map((spec) => ` *   ${spec.file.padEnd(width)}  ${spec.what}`).join('\n');
}

/**
 * 校验「常见指数清单」两份一致。
 *
 * 真源是 `lib/indices.js`（宿主直接 import），客户端那份在 `src/client/indices.js`
 * —— bundle 必须自包含，不能运行时 import，所以只能复制一份。这里在构建期比对，
 * 不一致直接失败：宁可构建报错，也不要两边悄悄漂移。
 */
function verifyIndexList() {
  const libSrc = readFileSync(join(ROOT, 'lib', 'indices.js'), 'utf8');
  const clientSrc = readFileSync(join(SRC, 'indices.js'), 'utf8');

  /**
   * 从形如 { code: '000300', prefix: 'sh', name: '沪深300', group: 'cn' } 的行里抽条目。
   *
   * ⚠️ 代码**不都是 6 位数字**：港股/美股指数是字母（恒生 `HSI`、道指 `DJI`）。
   * 所以这里匹配 `[A-Za-z0-9.]+`，前缀也扩到 hk/us。之前写死 `\d{6}` 与 `(sh|sz|bj)`
   * 时，新增的港股/美股条目会被**静默忽略** —— 那样"两份一致"的校验就形同虚设。
   */
  const parse = (text, label) => {
    const rows = [
      ...text.matchAll(
        /\{\s*code:\s*'([A-Za-z0-9.]+)',\s*prefix:\s*'(sh|sz|bj|hk|us)',\s*name:\s*'([^']+)',\s*group:\s*'(cn|hk|us)'\s*\}/g,
      ),
    ].map((m) => `${m[1]}|${m[2]}|${m[3]}|${m[4]}`);
    if (rows.length === 0) throw new Error(`${label}: 没解析出任何指数条目`);
    // 条数必须与源码里 `code:` 的出现次数吻合，否则说明有行没被上面的正则覆盖到
    const declared = (text.match(/\bcode:\s*'/g) ?? []).length;
    if (rows.length !== declared) {
      throw new Error(`${label}: 解析到 ${rows.length} 条，但源码里有 ${declared} 处 code: —— 有条目没被校验覆盖`);
    }
    return rows;
  };

  const a = parse(libSrc, 'lib/indices.js');
  const b = parse(clientSrc, 'src/client/indices.js');
  if (a.join(' ') !== b.join(' ')) {
    throw new Error(
      `指数清单两份不一致（真源 lib/indices.js）：\n  宿主: ${a.join(', ')}\n  客户端: ${b.join(', ')}`,
    );
  }
  return a.length;
}

/** 读模块体，并把 CSS 占位符替换成真正的样式文本。 */
function readModule(spec, css) {
  const raw = readFileSync(join(SRC, spec.file), 'utf8');
  if (/^\s*import\s/m.test(raw)) throw new Error(`${spec.file}: 模块体不能有顶层 import`);
  if (/^\s*export\s/m.test(raw)) throw new Error(`${spec.file}: 模块体不能有顶层 export`);
  return raw.replace(/__CSS_TEXT__/g, JSON.stringify(css)).trim();
}

/** 生成依赖声明行。 */
function depLines(spec) {
  const lines = [];
  const platformNames = Object.keys(PLATFORM);
  if (spec.deps.includes('@platform')) {
    platformNames.forEach((name) => lines.push(`var ${name} = ${PLATFORM[name]};`));
  }
  for (const dep of spec.deps) {
    if (dep === '@platform') continue;
    const exported = EXPORTS[dep];
    if (exported === undefined) throw new Error(`${spec.name}: 未知依赖 ${dep}`);
    if (exported.length === 0) continue;
    const alias = dep.replace(/-/g, '_');
    lines.push(`var ${alias} = R(${JSON.stringify(dep)});`);
    exported.forEach((key) => lines.push(`var ${key} = ${alias}.${key};`));
  }
  return lines;
}

/**
 * 校验模块的依赖声明是否自洽。
 *
 * ⚠️ 反向检查（用了却没声明）必须放在**最前面**：下面 `@platform` 分支会提前
 * `return`，而几乎所有组件模块都声明了 `@platform` —— 放在 return 之后就等于
 * 对它们完全不生效。这个坑我第一次就踩了：检查写完，故意去掉 `prefs` 依赖，
 * 构建照样通过。
 */
/**
 * 剥掉注释与字符串字面量，只留下真正会被求值的代码。
 *
 * 为什么必须剥：反向依赖检查若扫原始文本，会被**注释里的散文**误伤。
 * 例如 `market.js` 的注释里写了"（而不是 KlineChart 内部 state）"，
 * 就会被判成"用了 chart 模块的 KlineChart 却没声明依赖"，构建被无故拦下 ——
 * 第一版检查正是这么误报的。
 *
 * 不是完整的词法分析器，但对本项目这种规模的源码足够：
 * 识别 `//`、块注释、以及三种字符串引号（含反斜杠转义）。
 */
function stripCommentsAndStrings(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && code[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      // 留一个空格，避免把被字符串隔开的两段标识符粘成一个
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function verifyDeps(spec, body) {
  /**
   * 反向检查：用了别的模块导出的符号，却没把它声明成依赖。
   *
   * ⚠️ 这个检查是被一个真实 bug 逼出来的：`chart-panel.js` 里写了
   * `fetch(API + '/search?...')`，但它的 deps 里**没有 prefs** ——
   * 于是构建不会注入 `var API = prefs.API;`，那个 `API` 是未定义标识符。
   *
   * 这个错误在 `setTimeout` 回调里同步抛出，Promise 的 `.catch()` 捕不到，
   * 所以**不报错、不崩溃，只是永远静默失败** —— 表现在界面上就是
   * 「搜索框输入后永远显示没有匹配」。找了很久才定位到。
   *
   * 只检查"其它模块导出过的名字"：这样不会误伤 `fetch`、`Math` 这类全局量。
   */
  const code = stripCommentsAndStrings(body);
  const declared = new Set(['@platform', spec.name]);
  for (const dep of spec.deps) declared.add(dep);
  const foreign = new Map();
  for (const [mod, keys] of Object.entries(EXPORTS)) {
    if (declared.has(mod)) continue;
    for (const key of keys) {
      if (!foreign.has(key)) foreign.set(key, mod);
    }
  }
  for (const [key, mod] of foreign) {
    // 用词边界匹配标识符，避免 `API` 命中 `MY_API` 之类
    const pattern = new RegExp(`(?<![\\w$.])${key.replace(/\$/g, '\\$')}(?![\\w$])`);
    if (pattern.test(code)) {
      throw new Error(
        `${spec.name}: 用到了 ${mod} 导出的 ${key}，但 deps 里没有 ${mod}` +
          `（构建不会注入它 → 运行时是未定义标识符，且 Promise 的 catch 捕不到）`,
      );
    }
  }

  if (spec.deps.includes('@platform')) {
    const used = Object.keys(PLATFORM).filter((name) => body.includes(`h(`) && name === 'h' ? true : body.includes(name));
    if (used.length === 0) throw new Error(`${spec.name}: 声明了 @platform 却没用到`);
    // @platform 以外还要继续查"声明了没用"的那些依赖，所以这里不 return
  }
  for (const dep of spec.deps) {
    if (dep === '@platform') continue;
    const alias = dep.replace(/-/g, '_');
    const used = body.includes(`${alias}.`) || EXPORTS[dep].some((key) => body.includes(key));
    if (!used) throw new Error(`${spec.name}: 声明了依赖 ${dep} 却没用到`);
  }
}

/** 这个模块的 `return { ... }` 块（模块最外层那个）。 */
function moduleExportBlock(body) {
  const at = body.lastIndexOf('return {');
  if (at === -1) return '';
  const end = body.indexOf('};', at);
  return end === -1 ? body.slice(at) : body.slice(at, end);
}

/**
 * 校验 EXPORTS 表里声明的名字，模块**确实导出了**。
 *
 * ⚠️ 这是第三个同类静默失败：EXPORTS 里写了 `market: [..., 'REFRESH_MS_BY_PERIOD']`，
 * 但 market.js 的 `return { ... }` 里漏了它 —— 依赖方拿到的是 `undefined`，
 * 不报错、不崩溃，只是功能不生效（表现：自动刷新间隔表读不到，定时器间隔变成兜底值）。
 *
 * 上一个守卫只能保证"用到的名字来自已声明的依赖"，管不了"依赖是否真的导出了它"。
 */
function verifyExports(spec, body) {
  const block = moduleExportBlock(body);
  for (const key of EXPORTS[spec.name]) {
    const declared = new RegExp(`(?<![\\w$])${key.replace(/\$/g, '\\$')}\\s*[:,]`).test(block);
    if (!declared) {
      throw new Error(
        `${spec.name}: EXPORTS 表声明导出了 ${key}，但模块的 return { ... } 里没有它` +
          `（依赖方会拿到 undefined —— 又一种静默失败）`,
      );
    }
  }
}

function build() {
  const css = readFileSync(CSS_FILE, 'utf8').trimEnd();
  const parts = [];

  parts.push(`/**
 * dsh-stock-kline 浏览器半侧 bundle —— **构建产物，请勿直接编辑**。
 *
 * 源码在 src/client/ 下按模块拆分，重新生成：node scripts/build.mjs
 *
 * 模块（顺序 = 初始化顺序）：
${moduleListComment()}
 */
window.__ModuleLoader__.load({
  id: 'dsh-stock-kline',
  factory: function (require) {
    /** 模块表：按 MODULES 顺序初始化，前一个可以是后一个的依赖。 */
    var __factories = {};
    var __cache = {};
    function R(name) {
      if (Object.prototype.hasOwnProperty.call(__cache, name)) return __cache[name];
      var factory = __factories[name];
      if (factory === undefined) throw new Error('未知模块：' + name);
      var exports = factory();
      __cache[name] = exports;
      return exports;
    }
`);

  for (const spec of MODULES) {
    const body = readModule(spec, css);
    verifyDeps(spec, body);
    verifyExports(spec, body);
    const deps = depLines(spec);
    const indented = body
      .split('\n')
      .map((line) => (line === '' ? '' : '  ' + line))
      .join('\n');
    parts.push(`    // ===================== ${spec.name} =====================
    __factories[${JSON.stringify(spec.name)}] = function () {
${deps.map((line) => '  ' + line).join('\n')}${deps.length > 0 ? '\n' : ''}${indented}
    };
`);
  }

  parts.push(`    // ===================== 启动 =====================
    var plugin = R('plugin');
    return { apply: plugin.apply, inject: plugin.inject, name: plugin.name, __test: plugin.__test };
  },
});
`);

  return { text: parts.join('\n'), css };
}

/** 成品自检：占位符、import/export、CSS 结构、注册形态。 */
function selfCheck(text, css) {
  if (text.includes('__CSS_TEXT__')) throw new Error('CSS 占位符没有被替换');
  if (/^\s*import\s/m.test(text)) throw new Error('产物里出现了顶层 import');
  if (/^\s*export\s/m.test(text)) throw new Error('产物里出现了顶层 export');
  if (!text.includes('window.__ModuleLoader__.load(')) throw new Error('产物没有注册到 __ModuleLoader__');

  let depth = 0;
  let underflow = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < 0) underflow++;
    }
  }
  if (depth !== 0 || underflow !== 0) throw new Error(`CSS 花括号不配平 depth=${depth} underflow=${underflow}`);

  const cssLines = css.split('\n').filter((line) => line.trim() !== '');
  const truncated = cssLines.filter((line) => (line.includes('{') && !line.includes('}')) || (!line.includes('{') && line.includes('}')));
  if (truncated.length > 0) throw new Error('CSS 有不完整的单行规则：' + truncated[0].slice(0, 80));
  const orphans = cssLines.filter((line) => !line.includes('{') && !line.includes('}') && /^[a-z-]+\s*:/.test(line.trim()));
  if (orphans.length > 0) throw new Error('CSS 有孤儿属性行：' + orphans[0].slice(0, 80));

  return { cssRules: cssLines.length };
}

const checkOnly = process.argv.includes('--check');
const { text, css } = build();
const { cssRules } = selfCheck(text, css);
// 指数清单两份必须一致（真源 lib/indices.js）——不一致就此失败
const indexCount = verifyIndexList();

if (checkOnly) {
  console.log(
    `build --check OK：${MODULES.length} 个模块，产物 ${text.length} 字符，CSS ${cssRules} 条规则，指数 ${indexCount} 个`,
  );
} else {
  writeFileSync(OUT, text, 'utf8');
  console.log(`已生成 ${OUT}`);
  console.log(
    `  模块 ${MODULES.length} 个｜产物 ${text.length} 字符｜CSS ${cssRules} 条规则｜指数 ${indexCount} 个（两份清单一致）`,
  );
}
