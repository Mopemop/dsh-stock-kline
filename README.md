# dsh-stock-kline · 同花顺实时 K 线行情面板

在 DeepSeek Harness 的界面里直接看 A 股实时 K 线：**主面板大图 + 对话页背景 K 线 + 右下角价格挂件**。
数据源以**同花顺**为主，指数走**东财 → 腾讯**，响应里带 `source` 字段标明实际来源。

## 功能

| 能力 | 说明 |
|---|---|
| 常见指数 | 面板上一排快捷按钮（沪深300 / 中证500 / 上证50 / 深证成指 / 创业板指 / 中小100），一次点击直达 |
| 其他股票 | 搜索框输代码 / 中文名 / 拼音（`600519`、`贵州茅台`、`gzmt`），**输入即自动联想**，结果列在下方；支持 ↑/↓ 选择 + 回车，也可直接点击 |
| 周期 | 分时、5 / 15 / 30 / 60 分钟、日 K、周 K、月 K |
| 图表 | 蜡烛图（红涨绿跌）、成交量副图、均线（默认 MA5/10/20）、最新价虚线、昨收分界线 |
| 交互 | 滚轮缩放（按帧合并，可夹到 20~240 根）、悬停十字光标 + 当根数据行 |
| 刷新 | **自动**（间隔跟随周期，见下表）+ 面板上的「刷新」按钮手动补一次 |
| 价格挂件 | 右下角透明小标签：只有名称 + 涨跌百分比；可拖动、双击归位 |
| 对话页背景 | K 线铺在对话内容底下（低透明度、不吃鼠标） |
| 记忆 | 当前代码、周期、均线、**缩放维度**、挂件开关与位置、背景开关都存在 `~/.dsh/dsh-stock-kline/prefs.json` |
| 模型工具 | 宿主半侧注册只读工具 `stock_kline`，Agent 读的是同一份数据（`tools` 服务不在场时自动跳过） |

### 自动刷新间隔（跟随周期）

| 周期 | 间隔 | 为什么 |
|---|---|---|
| 分时 | **5s** | 看的是一整天的逐笔走势，要的就是即时 |
| 5 分钟 | 10s | |
| 15 分钟 | 15s | |
| 30 分钟 | 30s | |
| 60 分钟 | 30s | |
| 日 / 周 / 月 K | 60s | 最后一根收盘价全天都在变，要刷；但不需要太勤 |

两端各有一个刻意的边界：**5 秒下限**（不打得太密）、**60 秒上限**
（不管看哪个周期，屏幕上的价格最多 1 分钟就该动一次，否则用户会怀疑数据挂了）。

行为细节：

- 定时器挂在**插件级**（`plugin.js` 的 effect），不是面板组件的 effect ——
  因为**浮窗与背景 K 线在对话页就能看到**，若只在面板挂载时启动，一离开行情页就冻住；
- 切换周期会**重建**定时器（分时 5s ↔ 月K 60s），旧的一定被 `clearInterval` 掉；
- 页面切到后台（`visibilityState === 'hidden'`）时定时器照排但**回调直接返回不取数**；
  回到前台**立刻补一次**，免得看到一屏过期数字；
- 同一间隔内被连续触发多次时，`refresh()` 会**复用同一个在途请求**（`inFlight`），不堆积。

> 📌 加这个功能之前，这个插件其实**不是实时的**：`refresh()` 全项目只有"用户动作"调用点
> （切股票、切周期、点刷新），没有任何定时器。测试曾专门钉住"推进 2 分钟也没有新请求"。
> 现在 `test/live-update.test.mjs` 反过来钉住"该刷新时必须刷新、间隔必须随周期换档"。

> 已移除：自选股、刷新间隔选择、迷你图。
> （「刷新间隔选择」是**让用户挑**间隔的按钮组；现在间隔由周期推导，不再需要那排按钮。）

> ⚠️ **说明文字不能承诺做不到的操作。** 这里曾写着「按住拖动平移」和
> 「点击图例区看历史值」，两者都不成立：
>   · 拖动平移因指针捕获挂错元素而失效（根因与修法见
>     「拖动平移为什么曾失效：指针捕获挂错了元素」一节）；
>   · 图例根本没有 `onClick`，而且 CSS 是 `pointer-events:none`，点不动。
> 现在功能表只列**确实可用**的操作。

## 数据源分层

| 标的 | 顺序 | 说明 |
|---|---|---|
| 个股 | 同花顺 → 东财 → 腾讯 | 同花顺最全（含分时） |
| **指数** | **东财 → 腾讯**（跳过同花顺） | 同花顺 `v6/line/*` 对指数一律 502/504/404，且 `hs_000001` 会被它当成深市个股返回「平安银行」 |

指数的**分时**两边都拿不到（同花顺 `v6/time/hs_000300` 直接 404，东财 1 分钟线不支持指数），
所以默认周期是**日 K**，保证"打开就有图"。

> **涨跌幅基准**优先取**倒数第二根 K 线收盘**，源返回的昨收只作兜底。
> 因为数据源的"昨收"字段不可靠：实测东财对**指数**返回的 `preKPrice` 与 K 线不自洽
> （沪深300 给 4593.98，而相邻两根是 4310.28 → 4317.25），照它算出来是 `-6%` 这种
> 明显错误的值；用同一份 K 线数组里的前一根，则与图上画的东西天然自洽。

## 拖动侧栏时不能卡

拖动侧栏边框时，壳层**每帧**都在改 `.frame` 的 `grid-template-columns`，
`MutationObserver` 于是每帧触发一次。皮肤因此做了三重优化（都有回归测试）：

| 措施 | 效果 |
|---|---|
| 节流：两次真正同步至少隔 50ms，拖完补一次 | 逐帧 → 最多每 3 帧一次 |
| 快路径：层已在目标容器里就直接返回，不扫全文档 | 拖动期间 0 次 `querySelectorAll` |
| 尺寸阈值：宽高变化 < 3% 交给 CSS 拉伸（`preserveAspectRatio="none"`） | 拖动期间基本不重拼 SVG |
| 只订阅 `childList`，不订阅 `attributes` | 拖动改的是内联 style，不再触发回调 |

实测：模拟 60 帧拖动（容器 900 → 1140px），**重绘 1 次、全文档扫描 0 次**。

`src/client/indices.js` 与 `lib/indices.js` 是同一张指数清单的两份拷贝（bundle 必须自包含，
不能运行时 import）——`scripts/build.mjs` 会在构建期比对，**不一致直接构建失败**。

## 位置

### 1. 右下角价格挂件（主入口）

挂在 `shell.overlay`：透明背景的一行小字 —— **名称 + 涨跌百分比**（红涨绿跌，
颜色写死不用主题变量）。鼠标移上去才出现关闭按钮，按住可拖动，双击回到右下角。
因为背景透明，文字带一圈白色描边（`paint-order:stroke fill`）保证压在浅色背景上也读得清。

### 2. 对话页背景 K 线

注入到**对话页面容器自己内部**（`[data-phase]` 那个 `_root` 节点），不是外层 `.centerCol`
——因为页容器自带不透明底色 + `position:relative`，挂外面会被整个盖住。
层是 `position:absolute; inset:0; z-index:0; pointer-events:none`：在内容之下、鼠标穿透。

### 3. 行情主面板

`main` 键 `stock-kline`：指数快捷行 + 周期切换 + 搜索 + 手动刷新 + 大图。
入口是左侧栏的面板图标（部分构建里那排图标不渲染，所以它是备用入口）。

### 偏好与兜底入口

偏好以**浏览器本地存储为主**，同时尽力同步到宿主 `prefs.json`：
宿主那半边的字段白名单是**进程启动时加载的**，插件升级后不重启 DSH 就不认识新字段，
所以本地存储才是「下次打开还认得」的可靠来源。

### 三个开关的职责边界

界面上一共能关三样东西，**互不影响**：

| 开关在哪 | 管什么 | 不管什么 |
|---|---|---|
| 浮窗上的 `×` | 关掉浮窗本身 | 不动背景皮肤，**也不停取数** |
| 「行情 K 线」面板 → `浮窗 开/关` | 浮窗显不显示（浮窗关掉后的**回程入口**） | 同上 |
| 「行情 K 线」面板 → `皮肤 开/关` | 对话页铺不铺 K 线背景 | **不动取数**、不动浮窗 |
| 设置 → 通用 → 「对话页显示 K 线背景」 | 同上（与面板那个是**同一个开关**的另一个入口） | 同上 |

> **取数只跟随「当前代码 + 周期」**，与上面所有开关都无关。
> 面板上的 `浮窗` / `皮肤` 两个按钮各写各的字段，互不影响（都有断言钉住）。
> 所以关掉浮窗不会让背景 K 线断数据、断显示。

浮窗开关放在面板而不是设置页，是因为：浮窗的 `×` 一关，用户就**没法从浮窗回到面板**了，
所以回程入口必须和它所服务的那个面板在一起，而不是藏在齿轮里。

| 槽位 | 作用 |
|---|---|
| `shell.overlay` id `stock-kline-ticker` | 右下角价格挂件 |
| `shell.overlay` id `stock-kline-skin` | 对话页背景 K 线控制器 |
| `main` key `stock-kline` | 行情主面板大图（含浮窗开关） |
| `sidebar.panellist` id `stock-kline` | 侧边栏图标（备用入口） |
| `settings.general.item` | 「对话页显示 K 线背景」开关 |

### 滚轮缩放的上下限

滚轮只改"可见根数"，范围由一个纯函数 `clampCount` 统一夹取（**不再各处各夹**）：

| 常量 | 值 | 为什么 |
|---|---|---|
| `MIN_VISIBLE_BARS` | **20** | 放大到只剩十几根时，每根蜡烛分到几十像素，实体被上限钳到 18px 后与真实步长脱节，网格/均线/光标也被拉到极陡 —— 整个图面糊成色块（用户反馈的"放大太多后直接黑屏"） |
| `MAX_VISIBLE_BARS` | **240** | 全部画出来时每根要 2~4 个 SVG 节点，上千根就是几千个节点，页面卡死；240 根约一年日线，再多没有信息量 |

`clampVisibleBars(count, total)` 的三个边界都要守：总数比下限还少（新股/短数据）时**以总数为准**，
不能返回比总数还大的值；`total = 0` 和 `NaN` 也不能漏出去。

滚轮的实际递进走 `zoomStepsToCount(count, steps, total)`，以**已夹取的当前值**为基准，
所以在下限处来回滚不会"攒"出越界的意图值。

> **这两个函数住在 `format.js`**（不是 `chart.js`）：主面板与对话背景都要用同一份上下限，
> 各写一份必然漂移。`market` 模块也因此依赖 `format`，好让 `setZoom` 复用夹取。

> 这两个纯函数被 `__test` 暴露出来单测 —— **不能靠"滚轮后重渲染数根数"验证**：
> 测试台每次 `render()` 都重置 hook 槽位，缩放状态存不下来，那样测出来永远是初始值（假阳性）。

### 缩放维度同步到对话背景

需求：主面板缩放到哪个区间，对话背景就画**同一段**行情。

做法是把可见根数从 `KlineChart` 的内部 state 提到 store：

```
主面板滚轮 → onZoom → store.setZoom（带上下限夹取）→ 持久化
                                  ↓
                      对话背景读 snapshot.zoom
```

| 环节 | 位置 | 说明 |
|---|---|---|
| 维度定义 | `market.js` `state.zoom` | 默认 `DEFAULT_VISIBLE_BARS`（120） |
| 写入 | `market.js` `setZoom(count, total)` | 夹取走共享的 `clampVisibleBars`，不自己写一份 |
| 受控传参 | `chart.js` | `props.zoom` 进、`props.onZoom` 出；不传则退回内部 state |
| 接入 | `chart-panel.js` | `zoom={state.zoom}` + `onZoom={count => store.setZoom(count, quote.candles.length)}` |
| 读取 | `skin.js` | `snapshot.zoom` 决定画多少根 |
| 持久化 | `prefs.js` / 宿主 `PREF_SHAPE` | `zoom` 进白名单，刷新后还是上次的缩放 |

背景侧还有一个**基于自身宽度的上限**（`max(24, plotW/8)`）：背景是窄条，
若主面板看了 240 根而背景只有 280px，每根不到 1.2px 会糊成一片色。
于是"放大时完全一致，缩到极限时保护背景可读性"。

> ⚠️ **最容易漏的一步**：皮肤的 `revision()` 是重绘判据，`zoom` 必须拼进这个 key，
> 否则主面板缩放后 `revision` 不变 → 背景不重绘 → 同步**静默失效**（画面还是旧根数）。
> 这一步有专门断言钉住。

### 受控缩放必须在**挂载时**就生效

`chart.js` 里有个"换股票/周期重置视野"的 effect。**`useEffect` 在挂载时必然跑一次**，
所以它曾把受控缩放直接覆盖掉，表现是：

> 离开行情面板再回来，**缩放丢失**；滚一下轮子又**跳回**原本缩放。

后半句正是诊断线索：`countRef` 里存的还是正确的缩放值，所以下一次滚轮以它为基准缩放，
画面就"跳回"去了 —— 说明问题出在"挂载时把 state 写坏了"，而不是缩放值本身没保存。

现在该 effect 区分两种情况：

| 情况 | 可见根数 | offset |
|---|---|---|
| 受控（面板，有 `props.zoom`） | 取 `props.zoom` —— 缩放是跨股票/跨会话保留的**维度**，不该被重置 | 归零（回到最新） |
| 非受控（独立使用/迷你图） | 按周期挑默认值 | 归零 |

> 📌 这条回归由 **`test/zoom-mount.test.mjs`** 单独守。它不放进主测试台是有原因的：
> 主测试台的 `useEffect` 桩只在"首次遇到该 hook 索引"时排队，同一组件渲染过一次后
> 挂载期 effect 就再也不跑；而且它每次 `render()` 只展开一遍，看不到"effect 覆盖 state"。
> 我在那里写过一条读渲染树的断言，**把修复回退掉它照样 PASS**（假阳性，比没有断言更危险）。
> 独立测试用的是"按组件 key 持久化 state + 每次渲染后 flush effect 再渲染一遍"的最小 harness，
> 已验证：回退修复后 4 条断言里 3 条立刻 FAIL。

### 滚轮事件必须按帧合并（"滑太快黑屏"的根因）

**快速**滚动时滚轮事件的速率远高于帧率 —— 一帧里能来 5~10 个。
如果每个事件都 `setView`，就是一帧内触发十次完整 React 重渲染，
而每次要重建 240 根蜡烛（含成交量近 500 个 SVG 节点）。主线程被塞满后
来不及把画面提交给合成器，就呈现不出内容 —— 观感正是"滑太快直接黑屏"。
**慢速滚动每帧只有一个事件，所以不出问题**，这也解释了为什么只有"滑得快"才复现。

修法：事件里只累加"缩放意图"，用 `requestAnimationFrame` 在一帧结束时统一应用一次。

```js
acc.steps += event.deltaY > 0 ? 1 : -1;   // 只记方向，不记原始 deltaY
if (acc.pending) return;                  // 本帧已排队
acc.pending = true;
acc.frame = window.requestAnimationFrame(applyWheel);
```

> ⚠️ 判断"本帧是否已排队"用的是**独立的布尔量**，不能拿 `frame !== 0` 当判据：
> `requestAnimationFrame` 的返回值合法地可以是 0，那样守卫会失效，
> 变成每个事件都排一次 —— 正好退回要修的行为（这个坑我就是先踩了才发现的）。

实测：一帧内 10 个滚轮事件**只排 1 次 rAF**（有断言钉住）。

### 黑屏的真因：悬停下标越界导致组件崩溃

用户报的"滚轮放大太多黑屏"，console 里的真凶是：

```
TypeError: Cannot read properties of undefined (reading 'row')  at KlineChart
client.js:618 slot entry crashed in 'main'
```

**KlineChart 抛异常 → shell 的错误边界兜住 → 面板什么都不渲染 = 黑屏。**

崩溃点：

```js
var hoverItem = geometry !== null ? geometry.items[hover] : null;
var legendRow = hoverItem !== null ? hoverItem.row : last;   // ← undefined.row 抛错
```

`geometry.items[hover]` 在 `hover` **越界**时返回 `undefined`，而 **`undefined !== null` 是 `true`** ——
守卫漏过，下一行就崩。触发条件正是"鼠标悬停着滚轮放大"：可见根数骤减，
`hover` 还停在旧下标上（悬停第 150 根、放大到只剩 20 根）。

修法两条：
1. `hoverItem` 做**长度校验**并**归一化成 `null`**（下游才能安全地只判 `!== null`）；
2. 缩放改变可见根数时 `setHover(null)` —— 否则十字光标会指向错误的蜡烛。

> 排查教训：这个 bug 我前两轮都归因到"缩放值太大"，全错。
> 真正定位靠的是用户把 console 贴出来。**在能看到异常栈之前，不要猜原因。**

### React 的 onWheel 是 passive 的

另一条 console 警告说明了滚动为什么会穿透：

```
Unable to preventDefault inside passive event listener invocation.
```

React 17+ 把 `onWheel` 注册成 **passive**，`preventDefault()` 会被忽略。
所以拦页面滚动必须另挂一个**原生非 passive** 监听，两者分工要清楚：

| 位置 | 做什么 | 不能做什么 |
|---|---|---|
| 原生监听（`passive: false`） | `preventDefault()` 拦页面滚动 | **不能 `stopPropagation`** —— 否则 React 的 onWheel 收不到，缩放失效 |
| React `onWheel` | `stopPropagation()` 拦冒泡 + 缩放逻辑 | `preventDefault()` 无效，别写（白刷警告） |

为什么 React 那层要 `stopPropagation`：对话区域自己也装了 wheel 监听
（ui-conversation 的 `widthHandle` / `installDraftWheel`），不拦住就会顺带滚动背后内容。

### 拖动平移为什么曾失效：指针捕获挂错了元素

用户反馈"按住拖动平移没有效果"。根因是 `setPointerCapture` 捕获在**父容器**上，
而指针处理器挂在**子元素 `<svg>`** 上：

```js
var onPointerDown = function (event) {
  var node = hostRef.current;                    // ← .dsk-canvas（父）
  dragRef.current = { x: event.clientX, offset: view.offset };
  if (node.setPointerCapture) node.setPointerCapture(event.pointerId);
};
// 处理器实际挂在：
h('svg', { onPointerMove: onPointerMove, onPointerUp: onPointerUp, ... })   // ← 子元素
```

指针捕获会把后续 `pointermove` **重定向到捕获元素**，事件路径随之变成
`捕获元素 → … → root`。`<svg>` 是容器的**后代**，不在路径上 ——
它的 `onPointerMove` / `onPointerUp` 全都收不到：

| 收不到什么 | 后果 |
|---|---|
| `onPointerMove` | 拖动完全无效（用户报的"没效果"） |
| `onPointerUp` | `dragRef` 残留 → 之后**普通悬停都会误触发平移** |

修法：捕获目标改用 `event.currentTarget`（= **当前处理器所在元素**），
保证"捕获元素 === 处理器元素"：

```js
var target = event.currentTarget ?? hostRef.current;
target.setPointerCapture?.(event.pointerId);   // try/catch：pointerId 非法时不能中断拖动
```

> 有意思的是**浮窗的拖动一直是好的**，因为它用的是另一套做法：
> `pointerdown` 只记账，move/up 监听在 `window` 上（`ticker.js`）——根本不用指针捕获。
> 同一个仓库里两套拖动实现，坏的这套恰好是"看起来更正规"的那套。

因为修之前这个功能确实无效，底部提示里的「按住拖动平移」被删掉了（说明文字不该承诺做不到的操作）；
修好后功能恢复，但提示按用户要求保持精简。

### 搜索框"永远显示没有匹配"：一个未定义标识符造成的静默失败

用户反馈"搜索栏输入时总显示没有匹配"。根因只有一行：

```js
// chart-panel.js
fetch(API + '/search?q=' + ...)   // ← 这个 API 是**未定义标识符**
```

`API` 由构建按模块的 `deps` 注入（`var API = prefs.API;`），而
`chart-panel` 的 deps 里**漏了 `prefs`** —— 于是它从未被注入。

为什么后果是"静默"的，而不是报错崩掉：

| 环节 | 发生了什么 |
|---|---|
| `fetch(API + …)` | 在 `setTimeout` 回调里**同步**抛 `ReferenceError` |
| `.catch(...)` | **捕不到** —— 同步抛错不是 Promise rejection |
| `setItems(...)` | 永不执行 → `items` 永远是 `[]` |
| 界面 | 下拉**永远**显示「没有匹配」 |

修法两步：给 `chart-panel` 补上 `prefs` 依赖；再在构建期加反向检查，让这类
"用了没声明"的符号不可能再溜过去。

### 构建期的反向依赖检查（`verifyDeps`）

原来的 `verifyDeps` 只查"声明了却没用"。这次补上反方向：
**用了别的模块导出的符号，却没声明那个模块 → 构建直接失败**。

```
Error: chart-panel: 用到了 prefs 导出的 API，但 deps 里没有 prefs
（构建不会注入它 → 运行时是未定义标识符，且 Promise 的 catch 捕不到）
```

两个踩过的坑，都写在代码注释里：

> ⚠️ **检查必须放在 `@platform` 分支的 `return` 之前**。几乎所有组件模块都声明了
> `@platform`，而那个分支原本会提前 `return` —— 检查放它后面等于对它们完全不生效。
> 第一版就是这样：写完检查，故意去掉 `prefs`，构建照样通过。

> ⚠️ **检查前必须剥掉注释与字符串**。第一版扫原始文本，被 `market.js` 注释里的一句
> "（而不是 KlineChart 内部 state）"误报成"用了 chart 模块的 KlineChart"。
> 现在先过 `stripCommentsAndStrings()`。

### 搜索联想必须区分"还没回来"和"真没有"

修好 `API` 之后还有第二层问题：即使请求正常，**在路上时 `items` 也是空数组**。
原来的渲染逻辑不看状态就下结论说「没有匹配」—— 用户看到的就是"一输入就显示没有匹配"。
所以现在有明确的三态：

| `status` | 下拉显示 |
|---|---|
| `idle` / `loading` | 「搜索中…」（不下任何结论） |
| `done` 且结果为空 | 「没有匹配，可回车直接尝试」 |
| `done` 且有结果 | 候选列表 |

配套改进：

- **每次新查询立刻清空上一轮结果** —— 否则新关键词下会短暂显示**别的股票**，比空列表更糟；
- **「直接查询「xxx」」兜底行** —— 以前只有回车能触发，用户根本不知道（旧提示语里那句
  "回车按输入尝试"就是这个意思）；
- **↑/↓ 高亮 + 回车选中**，鼠标移入也同步高亮（键盘与鼠标共用同一个"当前项"）；
- 防抖 120ms，`cancelled` 保证只有最后一次查询的结果能落地。

> 这一整套由 **`test/search.test.mjs`** 守。它单独一个文件，因为主测试台测不了：
> 它每次 `render()` 重置 hook 槽位（异步 setState 落不下来），而且它的 `useEffect`
> 桩忽略依赖数组 —— 而搜索的核心恰恰是"`query` 变了要重新发请求"。
> 独立 harness 实现了**依赖比较 + 状态跨渲染保留 + flush 后再渲染一遍**。
> 正是这个测试第一次跑就抛出了 `ReferenceError: API is not defined`，才定位到根因。

## 数据源与接口

宿主半侧（Node）代理请求，因为行情接口没有 CORS 头，浏览器不能直连。

### 同花顺（主源）

```
K 线   GET https://d.10jqka.com.cn/v6/line/<sym>/<period>/<year>.js
K 线   GET https://d.10jqka.com.cn/v6/line/<sym>/<period>/last1800.js
分时   GET https://d.10jqka.com.cn/v6/time/<sym>/last.js
当日   GET https://d.10jqka.com.cn/v6/line/<sym>/01/today.js
```

`period` 代码：`01` 日 / `11` 周 / `21` 月，`00` `10` `20` 为前复权口径（本插件用前复权系列）。
`data` 每根 K 线 11 段：`日期,开,高,低,收,成交量(股),成交额(元),换手率%,, ,0`。
股票名与昨收只存在于 `today.js`（年度 K 线文件里没有 `name` 字段）。

### 东方财富（兜底）

```
GET https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=<m>.<code>&klt=<1|5|15|30|60|101|102|103>&fqt=1
```

代码不存在时该接口返回 `data: null`（HTTP 仍 200），所以必须判 `data`。

### 搜索

```
GET https://smartbox.gtimg.cn/s3/?t=all&q=<关键词>
```

返回 `v_hint="sh~600519~\u8d35\u5dde\u8305\u53f0~gzmt~GP-A"`，多行用 `^` 分隔，名称是字面 `\uXXXX` 转义需要解码。

> 为什么不用东财的 `suggest` / `clist`：前者不带 `cb` 参数时返回的是社区用户搜索的 JSONP（拿不到证券代码），后者的全量列表接口在连续请求后会被直接 ECONNRESET（本机实测），不适合做高频交互的搜索依赖。

## 宿主路由

```
GET  /dsh-stock-kline/api/health
GET  /dsh-stock-kline/api/quote?symbol=600519&period=day&limit=240
GET  /dsh-stock-kline/api/search?q=茅台&limit=12
GET  /dsh-stock-kline/api/prefs
PUT  /dsh-stock-kline/api/prefs    （body 为部分偏好对象，白名单过滤）
```

## 结构

宿主半侧（Node，直接跑源码，无构建）：

```
lib/market.js   取数与解析（同花顺 / 东财 / 搜索 / 代码归一化），纯 ESM JavaScript
lib/index.js    宿主半侧入口：webServer 路由、偏好读写、stock_kline 工具
```

浏览器半侧**按职责拆成模块写，构建成一个自包含 bundle**：

```
src/client/                ← 改这里（每个文件一个职责）
  format.js        格式化、涨跌色、均线、昨收基准（纯函数，无 DOM/React）
  prefs.js         偏好读写（浏览器本地存储为主，尽力同步宿主）
  indices.js       常见指数清单（与 lib/indices.js 同源，构建期校验一致）
  styles.js        样式注入（CSS 文本在 styles/client.css）
  market.js        行情状态中心 store + 订阅 Hook（主面板/挂件/皮肤共用）
  chart.js         自绘 SVG K 线图（缩放、拖动平移、十字光标、成交量、均线）
  chart-panel.js   行情主面板（指数快捷行 + 整页大图）
  ticker.js        价格挂件（透明小标签：名称 + 涨跌百分比）
  skin.js          对话页背景 K 线（DOM 注入）
  plugin.js        插件入口：槽位注册与生命周期
  styles/client.css  全部样式
scripts/build.mjs  合成 → lib/client.js
scripts/sync.mjs   安装自检（早先是"同步到 node_modules"，现已不需要）
lib/client.js      ← 构建产物（勿手改）
```

### 为什么需要构建

DSH 的浏览器插件 bundle 由 `/plugins/<pkg>/client.js` **原样**送给页面，
不能有顶层 `import` / `export`（页面侧只是普通脚本 + `window.__ModuleLoader__`）。
所以源码按模块拆开写，构建时合成单文件：

```js
window.__ModuleLoader__.load({ id: 'dsh-stock-kline', factory: (require) => { ... } })
```

模块协议（见 `scripts/build.mjs`）：

- 每个 `src/client/*.js` 是一段**模块体**：不能有顶层 import/export，结尾 `return { ... }` 导出；
- 依赖由 `MODULES` 表声明，构建时按表注入 —— **依赖关系一眼可见**，
  并且会校验"声明了却没用到"；
- React 能力（`h` 与各 hook）作为 `@platform` 注入，运行时从 `require('react')` 取。

```bash
node scripts/build.mjs          # 生成 lib/client.js
node scripts/build.mjs --check  # 只校验（检查占位符/import/CSS 结构），测试里会跑
node scripts/sync.mjs --no-build # 安装自检（junction + bundle 声明）
```

## 安装（作为 DSH 受管 bundle）

本插件是一个 **bundle**：DSH 插件页里能列出它、能开关、能卸载，
和 `dsh-pet` / `dsh-ops` 处在同一套管理机制下。

### 从 GitHub 安装（普通用户走这条）

```
https://github.com/Mopemop/dsh-stock-kline
```

**方式一：插件页**
DSH 的「插件」页 → 「添加插件」→ 粘贴上面的仓库地址 → 安装 → 启用。

**方式二：对话里让 Agent 装**
让 Agent 用 `plugin_manager` 工具安装，spec 就是同一个地址：

```
plugin_manager  install_bundle  target = https://github.com/Mopemop/dsh-stock-kline
```

装完**重启一次 DSH**（bundle 层在启动时组合），插件页里就会多出一行
`dsh-stock-kline`，可以随时开关或卸载。

> 仓库里**包含 `lib/`（构建产物）**，所以安装方不需要跑构建 —— DSH 装上就直接读
> `lib/index.js`（宿主半侧）与 `lib/client.js`（浏览器半侧）。
> 这也是为什么 `.gitignore` 里没有 `lib/`。

### 本地开发安装（改源码的人走这条）

见下面「目录结构」与「安装 / 卸载」两节：用 `link:` 规格安装，`node_modules` 里是
指向源码目录的 junction，改完 `node scripts/build.mjs` 就生效，无需拷贝。

### 判定条件（缺一不可）

DSH 是否把它当受管插件，取决于三个事实：

| 事实 | 位置 | 缺了会怎样 |
|---|---|---|
| 包声明自己是 bundle | 包 `package.json` 的 `dsh.bundle.patch` | 插件页报 `not-bundle`；不会被加载 |
| 包被 profile 依赖 | profile `package.json` 的 `dependencies` | `installed: false` —— 插件页里不算"已安装" |
| 包被 profile 选中 | profile `package.json` 的 `dsh.profile.bundles` | `enabled: false` —— 列出了但没启用 |

> ⚠️ **曾经踩的坑**：早先是在 profile 的 `cordis.patch.yml` 里手写一行
> `- insert: - id: dsh-stock-kline`。这样插件**能跑**，但 DSH 只把它当成
> "补丁层里的一行普通条目"，**不认为它是一个可管控的插件** ——
> 所以插件页的「可启用插件」里根本看不到它。
> 手写 insert 与 bundle patch 都插同一个 entry id，两层都写还会重复注册；
> 现在挂载声明**只**在包自己的 `cordis.patch.yml` 里。

### 目录结构（安装后）

```
~/.dsh/profiles/desktop/
├── dsh-stock-kline/                  ← 源码 + 构建脚本（改这里）
│   ├── src/client/*.js  styles/
│   ├── lib/{market,index}.js  client.js（产物，DSH 直接读这个）
│   ├── assets/icon.svg              ← 插件图标
│   ├── scripts/build.mjs  sync.mjs  ← sync.mjs 已退休成"安装自检"
│   ├── test/*.mjs  package.json  cordis.patch.yml（= dsh.bundle.patch）
├── node_modules/dsh-stock-kline      ← **junction（目录符号链接）**，指向上面那个源码目录
└── package.json                      ← dependencies 用 link:，dsh.profile.bundles 含它
```

`node_modules/dsh-stock-kline` 是 **junction 而不是拷贝**，所以：

```powershell
cd ~\.dsh\profiles\desktop\dsh-stock-kline
node scripts\build.mjs     # 就这一步。不需要任何"同步"——
                           # node_modules 里那个目录就是源码目录本身
```

`sync.mjs` 因此退休成**安装自检**（确认链接没被破坏、bundle 声明完整）：

```powershell
node scripts\sync.mjs --no-build
```

### 安装 / 卸载

按绝对路径安装（`link:` 规格 → 建 junction，改源码即时生效）：

```
plugin_manager install_bundle  target = link:C:\Users\14525\.dsh\profiles\desktop\dsh-stock-kline
```

它会：跑 `pnpm add link:<路径>` → 校验 bundle patch → 把包名追加进
`dsh.profile.bundles`。卸载走 `remove_bundle`。

**宿主半侧要重启 DSH 才生效**（bundle 层在启动时组合）；浏览器半侧刷新页面即可。

> 兼容性检查只看 `@deepseek-ai/dsh*` 开头的 peer。本包的 peer 是
> `@deepseek-ai/cordis` 和 `react`，都不匹配，所以不声明 `dsh.compatibility` 也不会被拦。

## 测试

```bash
node scripts/build.mjs --check   # 构建自检：占位符 / import / CSS 规则完整性
node test/market.test.mjs        # 真网络：日/周/月/分时/5分/30分、东财兜底、搜索、代码归一化
node test/routes.test.mjs        # 宿主路由与偏好白名单（真网络取一次 quote）
node test/client-render.test.mjs # 客户端渲染：桩 React/DOM，用真实行情跑组件树
```

最后一个测试需要 DSH 正在运行（默认 `127.0.0.1:19387`，可用 `DSK_HOST` 覆盖），
它会加载**构建产物**、真实请求宿主路由、递归展开组件树，并断言：

- 槽位注册（main / sidebar.panellist / shell.overlay ×2 / settings ×2）
- 所有 SVG 数值属性有限（无 NaN），周期切换、悬停十字光标都正常
- 挂件用 `<text>` 画内容并带行情文案、每段都写死 `fill`
- 挂件容器与 svg 的固定尺寸内联写死
- 样式表**括号配平、无截断规则、无孤儿属性行**（这三条是"白底看不见文字"那次的回归防护）


