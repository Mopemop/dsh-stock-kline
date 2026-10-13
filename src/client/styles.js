/**
 * 样式注入。
 *
 * CSS 文本放在同目录的 `styles/client.css`，由构建脚本内联进 bundle
 * （DSH 客户端 bundle 必须自包含，不能运行时再发一次请求）。
 *
 * ## 两条硬约定（都是踩过的坑）
 *
 * 1. **每一条 CSS 都是完整规则**（选择器 + 收尾 `}`）。曾经按行清理旧样式，
 *    把多行拼接的规则拦腰截断，留下孤儿属性碎片；CSS 解析器遇到碎片会一路吞
 *    token 直到下一个 `;`/`}`，把紧随其后的整条规则吃掉 —— 表现就是
 *    「挂件纯白、文字全看不见」。所以 CSS 现在独立成 .css 文件，不再手拼字符串。
 *
 * 2. **`STYLE_TAG` 带版本号**。注入按 `data-plugin-css` 去重，沿用同一个 id 时
 *    页面上旧版本写的 `<style>` 会把新样式整体挡住（刷新也救不回来，因为新规则
 *    根本进不了 DOM）。**每次改样式都要提升版本号。**
 */
var STYLE_TAG = 'dsh-stock-kline/client.v10.css';

/** 由构建脚本替换为真正的 CSS 文本。 */
var STYLE_TEXT = __CSS_TEXT__;

/** 幂等注入；同版本已存在时直接覆盖内容，保证一定是最新的。 */
function installCss() {
  if (typeof document === 'undefined') return undefined;
  var existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG) + ']');
  if (existing !== null && existing !== undefined) {
    existing.textContent = STYLE_TEXT;
    return undefined;
  }
  var tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-stock-kline';
  tag.dataset.pluginCss = STYLE_TAG;
  tag.textContent = STYLE_TEXT;
  (document.head === undefined || document.head === null ? document.body : document.head).appendChild(tag);
  return undefined;
}

/** 取当前样式文本（测试与调试用）。 */
function getCss() {
  return STYLE_TEXT;
}

return { STYLE_TAG: STYLE_TAG, cssText: STYLE_TEXT, getCss: getCss, installCss: installCss };
