/**
 * 偏好读写
 *
 * 以浏览器本地存储为**主存储**：宿主那半边的字段白名单是进程启动时加载的，
 * 插件升级后不重启 DSH 就不认识新字段，所以本地存储才是「下次打开还认得」的来源。
 * 宿主同步尽力而为，失败不影响使用。
 */

var API = '/dsh-stock-kline/api';

var LOCAL_KEY = 'dsh-stock-kline:prefs';

/** 会被持久化的偏好字段（客户端与宿主共用同一张表）。 */
var PREF_KEYS = ['symbol', 'period', 'ma', 'tickerOpen', 'skinOpen', 'tickerBox', 'zoom'];

function loadLocalPrefs() {
  try {
    var raw = window.localStorage.getItem(LOCAL_KEY);
    return raw === null ? {} : JSON.parse(raw);
  } catch (error) {
    return {};
  }
}

function saveLocalPrefs(prefs) {
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(prefs));
  } catch (error) {
    /* 隐私模式等场景静默忽略 */
  }
}

return {
  API: API,
  LOCAL_KEY: LOCAL_KEY,
  PREF_KEYS: PREF_KEYS,
  loadLocalPrefs: loadLocalPrefs,
  saveLocalPrefs: saveLocalPrefs,
};
