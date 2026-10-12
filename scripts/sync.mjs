/**
 * 自检：确认本插件已按 **bundle** 方式被 DSH 安装（而不是"源码 + 手工拷贝"两份文件）。
 *
 * ## 历史
 *
 * 早先本插件是「profile 本地包」手工装的，于是有两份文件：
 *   <profile>/dsh-stock-kline/                源码（改这里）
 *   <profile>/node_modules/dsh-stock-kline/   实际被加载的包（手工拷过去）
 * 这个脚本就是那次拷贝。
 *
 * ## 现在
 *
 * 已经改为正规 bundle 安装（`plugin_manager.install_bundle` + `link:` 规格），
 * profile 的 `dependencies` 里是 `link:`，pnpm 建了一个 **junction（目录符号链接）**：
 *
 *   <profile>/node_modules/dsh-stock-kline  ──▶  <profile>/dsh-stock-kline
 *
 * 也就是说 node_modules 里那个目录**就是**源码目录本身：
 *   · `lib/client.js` 被 DSH 直接读取 —— 改完源码只需 `node scripts/build.mjs`，
 *     **不需要任何拷贝**；
 *   · 再跑旧的拷贝逻辑会把文件往自己身上拷（cpSync 会报 "same file" 或做无用功）。
 *
 * 所以这个脚本退休成自检：确认链接关系还在、bundle 声明完整。
 * 一旦链接被破坏（例如有人在 node_modules 里放了真的目录），它会明确报出来。
 *
 * 用法：
 *   node scripts/sync.mjs            # 先构建，再自检
 *   node scripts/sync.mjs --no-build # 只自检
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROFILE = dirname(ROOT);
const LINK = join(PROFILE, 'node_modules', 'dsh-stock-kline');

if (!process.argv.includes('--no-build')) {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { stdio: 'inherit' });
}

const problems = [];
const notes = [];

// 1) node_modules 里那一条必须是**链接**，不是拷贝
if (!existsSync(LINK)) {
  problems.push(`node_modules/dsh-stock-kline 不存在 —— 重新安装：pnpm add "link:${ROOT}"`);
} else {
  const st = lstatSync(LINK);
  const isLink = st.isSymbolicLink() || st.isDirectory() === false;
  // Windows 的 junction 在 lstat 下表现为 isSymbolicLink() === true
  if (isLink) {
    const target = realpathSync(LINK);
    const want = realpathSync(ROOT);
    if (resolve(target).toLowerCase() !== resolve(want).toLowerCase()) {
      problems.push(`junction 指向了别处：\n    实际 → ${target}\n    期望 → ${want}`);
    } else {
      notes.push(`junction 正常：node_modules/dsh-stock-kline → ${target}`);
    }
  } else {
    problems.push(
      'node_modules/dsh-stock-kline 是**真目录**而不是链接 —— 说明它是拷贝来的，' +
        '改源码不会生效。重新安装：pnpm add "link:' +
        ROOT +
        '"',
    );
  }
}

// 2) bundle 声明必须完整（缺了 DSH 就不会把它当受管插件）
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (pkg.dsh?.bundle?.patch === undefined) {
  problems.push('package.json 缺 dsh.bundle.patch —— DSH 不会把它识别为 bundle');
} else {
  const patchFile = join(ROOT, pkg.dsh.bundle.patch);
  if (!existsSync(patchFile)) problems.push(`dsh.bundle.patch 指向的文件不存在：${pkg.dsh.bundle.patch}`);
  else notes.push(`bundle patch：${pkg.dsh.bundle.patch}`);
}
if (pkg.dsh?.client === undefined) problems.push('package.json 缺 dsh.client —— 浏览器半侧不会被提供');
if (pkg.exports?.['./client'] === undefined) problems.push('package.json 缺 exports["./client"] —— 页面拿不到 client.js');

// 3) profile 侧记录（dependencies + dsh.profile.bundles 都要有）
const profilePkgPath = join(PROFILE, 'package.json');
if (existsSync(profilePkgPath)) {
  const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'));
  const name = pkg.name;
  if (profilePkg.dependencies?.[name] === undefined) {
    problems.push(`profile/package.json 的 dependencies 里没有 ${name}`);
  } else {
    notes.push(`profile 依赖：${name} → ${profilePkg.dependencies[name]}`);
  }
  if ((profilePkg.dsh?.profile?.bundles ?? []).includes(name)) {
    notes.push(`profile 已启用：dsh.profile.bundles 含 ${name}`);
  } else {
    problems.push(`profile 的 dsh.profile.bundles 里没有 ${name} —— 插件页会显示为未启用`);
  }
}

for (const n of notes) console.log('  ✓ ' + n);
if (problems.length > 0) {
  console.error('\n发现 ' + problems.length + ' 个问题：');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('\nBundle 安装状态正常 —— 改完源码只需 node scripts/build.mjs，无需同步。');
