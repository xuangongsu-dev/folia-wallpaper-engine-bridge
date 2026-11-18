'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Use Wallpaper Engine's official control process; never launch it when it is stopped.
const execute = promisify(execFile);
async function isWallpaperEngineRunning(executor = execute, platform = process.platform) {
  if (platform !== 'win32') return false;
  const { stdout } = await executor('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  return /^"wallpaper(?:32|64)\.exe"\s*,/im.test(stdout);
}

async function openWallpaper(installations, projectPath, log = () => {}, testDependencies = {}) {
  const executor = testDependencies.execute || execute;
  const cancelled = () => testDependencies.isCancelled?.() === true;
  const assertNotCancelled = () => { if (cancelled()) throw new Error('模组已停用，已取消桌面同步。'); };
  const result = { ok: false, projectPath, executable: null, args: ['-control', 'openWallpaper', '-file', projectPath], exitCode: null, stdout: '', stderr: '', error: null, checkedAt: new Date().toISOString() };
  try {
    assertNotCancelled();
    const installation = installations.find(root => fs.existsSync(path.join(root, 'wallpaper64.exe')) || fs.existsSync(path.join(root, 'wallpaper32.exe')));
    if (!installation) throw new Error('未找到 Wallpaper Engine 可执行文件。');
    result.executable = path.join(installation, fs.existsSync(path.join(installation, 'wallpaper64.exe')) ? 'wallpaper64.exe' : 'wallpaper32.exe');
    const running = await isWallpaperEngineRunning(executor, testDependencies.platform || process.platform);
    assertNotCancelled();
    if (!running) throw new Error('请先启动 Wallpaper Engine，再同步到桌面。Folia 的壁纸选择仍然有效。');
    if (!projectPath || !fs.statSync(projectPath).isFile() || path.basename(projectPath).toLowerCase() !== 'project.json') throw new Error('未找到可打开的 project.json。');
    // execFile quotes paths for Windows argv. No shell interpolation, HTML execution or file writes.
    assertNotCancelled();
    const { stdout, stderr } = await executor(result.executable, result.args, { cwd: installation, windowsHide: true, shell: false, timeout: 12000, maxBuffer: 256 * 1024 });
    result.ok = true;
    result.exitCode = 0;
    result.stdout = stdout.trim();
    result.stderr = stderr.trim();
    result.confirmed = false;
    result.message = 'Wallpaper Engine 控制进程正常返回（退出码 0）；尚未确认桌面渲染结果。';
  } catch (error) {
    result.exitCode = typeof error.code === 'number' ? error.code : null;
    result.stdout = String(error.stdout || '').trim().slice(0, 4096);
    result.stderr = String(error.stderr || '').trim().slice(0, 4096);
    result.error = error.killed ? '同步超时，Folia 壁纸选择已保留。' : error.message;
  }
  if (!cancelled()) log(result.ok ? 'info' : 'warn', `[wallpaper-engine-live] desktop control ${JSON.stringify(result)}`);
  return result;
}

module.exports = { isWallpaperEngineRunning, openWallpaper };
