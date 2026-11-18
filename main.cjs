'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { CONTENT_TYPES } = require('./media.cjs');
const { scanLibrary, currentDesktop, desktopRecord, resolveProjectAsset } = require('./library.cjs');
const { openWallpaper } = require('./desktop.cjs');
const { scenePackage, getSceneImage } = require('./sceneCache.cjs');

// The existing read-only asset server now also backs a persistent wallpaper library.
const STORAGE_KEY = 'library-selection-v1';

function serveFile(request, response, file) {
  let stat;
  try { stat = fs.statSync(file); if (!stat.isFile()) throw new Error('not a file'); }
  catch { response.writeHead(404); response.end('not found'); return; }
  const headers = {
    'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
  };
  let start = 0;
  let end = stat.size - 1;
  let statusCode = 200;
  const rawRange = request.headers.range;
  if (rawRange) {
    const range = /^bytes=(\d*)-(\d*)$/i.exec(rawRange);
    if (!range || (!range[1] && !range[2])) { response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` }); response.end(); return; }
    start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size || end < 0) { response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` }); response.end(); return; }
    statusCode = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  response.writeHead(statusCode, { ...headers, 'Content-Length': Math.max(0, end - start + 1) });
  if (request.method === 'HEAD' || !stat.size) { response.end(); return; }
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

function activate(api, testDependencies = {}) {
  // Optional injection keeps regression tests outside the user's real library and desktop.
  const scan = testDependencies.scanLibrary || scanLibrary;
  const open = testDependencies.openWallpaper || openWallpaper;
  let disposed = false;
  let pollTimer = null;
  let port = 0;
  let library = null;
  let selectedRecord = null;
  let desktopStamp = null;
  let preference = { selectionMode: 'manual', selectedProject: null, syncToDesktop: false };
  let state = { ok: false, mode: 'starting', title: null, kind: null, projectType: null, selectedProject: null, assetUrl: null, posterUrl: null, sourcePath: null, resolution: null, source: null, limitation: null, error: null, syncResult: null, revision: 0 };
  const token = crypto.randomBytes(24).toString('hex');
  const allowedFiles = new Map();
  const backgroundFiles = new Set();
  let operation = Promise.resolve();
  let sceneWork = Promise.resolve();
  let sceneJob = null;

  const cancelScene = () => {
    sceneJob?.abort();
    sceneJob = null;
  };

  const assertActive = () => { if (disposed) throw new Error('模组已停用。'); };
  const log = (level, message) => {
    if (disposed) return;
    try { api.log?.[level]?.(message); } catch { /* Logging never breaks the bridge. */ }
  };
  const snapshot = () => ({ ...state, selectionMode: preference.selectionMode, syncToDesktop: preference.syncToDesktop });
  const publish = () => {
    if (disposed) return;
    state.revision++;
    // Folium 1.6 has no send/on. The client always polls get-state; newer hosts also receive pushes.
    try { api.rpc.send?.('state', snapshot()); } catch { /* The client reconnects with get-state. */ }
  };
  const registerFile = file => {
    if (disposed) return null;
    if (!file || !CONTENT_TYPES[path.extname(file).toLowerCase()]) return null;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return null;
      const id = crypto.createHash('sha256').update(file).digest('hex').slice(0, 32);
      allowedFiles.set(id, file);
      return `http://127.0.0.1:${port}/${token}/media/${id}?v=${stat.size}-${stat.mtimeMs}`;
    } catch { return null; }
  };
  const rebuildAllowedFiles = () => {
    if (disposed) return;
    allowedFiles.clear();
    for (const item of library?.items || []) registerFile(item.previewPath);
    for (const file of backgroundFiles) registerFile(file);
  };
  const fail = message => {
    if (disposed) return snapshot();
    cancelScene();
    selectedRecord = null;
    backgroundFiles.clear();
    rebuildAllowedFiles();
    state = { ...state, ok: false, mode: 'error', title: null, kind: null, projectType: null, selectedProject: preference.selectionMode === 'manual' ? preference.selectedProject : null, assetUrl: null, posterUrl: null, sourcePath: null, resolution: null, source: null, limitation: null, scene: null, error: message };
    publish();
    return snapshot();
  };
  const persist = async next => {
    assertActive();
    const record = library?.records.get(next.selectedProject);
    const canonical = record ? { ...next, selectedProject: record.projectPath } : next;
    await api.storage.set(STORAGE_KEY, canonical);
    assertActive();
    preference = canonical;
  };

  const server = http.createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const prefix = `/${token}/media/`;
      if (!requestUrl.pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
      const id = requestUrl.pathname.slice(prefix.length);
      const file = allowedFiles.get(id);
      if (!file) { response.writeHead(404); response.end(); return; }
      serveFile(request, response, file);
    } catch { response.writeHead(400); response.end(); }
  });
  server.on('error', error => {
    if (disposed) return;
    fail(`壁纸资源服务失败：${error.message}`);
    log('error', `[wallpaper-engine-live] asset server failed: ${error.stack || error.message}`);
  });

  const showRecord = (record, resolved, scene = null) => {
    if (disposed) return snapshot();
    selectedRecord = record;
    backgroundFiles.clear();
    if (resolved.asset) backgroundFiles.add(resolved.asset);
    if (resolved.poster) backgroundFiles.add(resolved.poster);
    rebuildAllowedFiles();
    const assetUrl = registerFile(resolved.asset);
    state = {
      ...state, ok: Boolean(assetUrl), mode: assetUrl ? 'asset' : 'error',
      title: record.title, selectedProject: record.projectPath || record.id,
      projectType: record.type, kind: resolved.kind, assetUrl,
      posterUrl: registerFile(resolved.poster), sourcePath: resolved.asset,
      resolution: resolved.resolution, source: resolved.source, sourceRole: resolved.source,
      limitation: resolved.limitation, scene,
      error: assetUrl ? null : '项目中没有 Folia 可加载的图片或视频；仍可在 Wallpaper Engine 中打开。',
    };
    publish();
    log('info', `[wallpaper-engine-live] background ${JSON.stringify({ title: state.title, type: state.projectType, source: state.source, sourcePath: state.sourcePath, resolution: state.resolution, limitation: state.limitation })}`);
    return snapshot();
  };

  const applyRecord = async record => {
    assertActive();
    cancelScene();
    if (!record) return fail('未找到已选择的壁纸项目，请刷新列表并重新选择。');
    if (record.type !== 'scene') return showRecord(record, await resolveProjectAsset(record));

    selectedRecord = record;
    const controller = new AbortController();
    const { signal } = controller;
    sceneJob = controller;
    state = {
      ...state, ok: true, mode: 'scene-loading', title: record.title, selectedProject: record.projectPath || record.id,
      projectType: 'scene', kind: null, assetUrl: null, posterUrl: null, sourcePath: null, resolution: null,
      source: null, sourceRole: null, limitation: '正在读取场景的静态底图…', scene: null, error: null,
    };
    publish();

    // Jobs are outside the RPC queue. Only one copied package and decoder run at a time.
    sceneWork = sceneWork.then(async () => {
      if (signal.aborted || disposed) return;
      const baseline = await resolveProjectAsset(record, { sceneBackgroundOnly: true });
      if (signal.aborted || disposed) return;
      const pkgPath = scenePackage(record);
      let texture = { reason: 'no-package' };
      if (pkgPath) {
        try {
          texture = await getSceneImage(api.storage.paths.cache, record, pkgPath, baseline.resolution, signal);
        } catch (error) {
          texture = { reason: 'extraction-failed', detail: String(error.message).slice(0, 400), packagePath: pkgPath };
        }
      }
      if (signal.aborted || disposed) return;
      const { asset, ...scene } = texture;
      const staticNote = '动画、粒子和视差只在 Wallpaper Engine 中完整呈现。';
      const dimensions = size => size ? `${size.width}×${size.height}` : '尺寸未知';
      const reasonText = {
        'texture-decode-failed': '候选纹理解码失败',
        'package-size-limit': '场景包超过本地提取上限',
        'extraction-failed': '场景包读取或提取失败',
        'no-large-texture': '无可用大纹理',
        'no-package': '项目未提供可提取的场景包',
      }[scene.reason] || '无可用大纹理';
      const resolved = asset ? {
        ...baseline, asset, kind: 'image', source: 'scene-texture',
        resolution: { width: scene.width, height: scene.height },
        limitation: `静态高清底图 ${dimensions(scene)} · ${scene.format}。 ${staticNote}`,
      } : {
        ...baseline,
        limitation: baseline.source === 'preview' || !baseline.asset
          ? `${reasonText}，${baseline.asset ? `仅显示预览图 ${dimensions(baseline.resolution)}` : '项目也没有可用预览图'}。 ${staticNote}`
          : `静态场景资源 ${dimensions(baseline.resolution)}。 ${staticNote}`,
      };
      log('info', `[wallpaper-engine-live] scene ${JSON.stringify({ title: record.title, ...scene, asset: asset || baseline.asset })}`);
      showRecord(record, resolved, scene);
    }).catch(error => {
      if (signal.aborted || disposed) return;
      log('warn', `[wallpaper-engine-live] scene resolution failed: ${error.message}`);
      fail('场景资源读取失败，请重新选择。');
    });
    return snapshot();
  };
  const refreshWallpaper = async () => {
    assertActive();
    if (preference.selectionMode === 'follow') {
      const desktop = currentDesktop(library.roots);
      desktopStamp = desktop ? `${desktop.selected}:${fileStamp(desktop.configPath)}` : null;
      return applyRecord(desktopRecord(library, desktop?.selected));
    }
    const record = library.records.get(preference.selectedProject);
    if (record && preference.selectedProject !== record.projectPath) {
      await persist({ ...preference, selectedProject: record.projectPath });
    }
    assertActive();
    return applyRecord(record);
  };

  const ready = (async () => {
    const stored = await api.storage.get(STORAGE_KEY);
    if (disposed) return;
    if (stored && typeof stored === 'object') preference = {
      selectionMode: stored.selectionMode === 'follow' ? 'follow' : 'manual',
      selectedProject: typeof stored.selectedProject === 'string' ? stored.selectedProject : null,
      syncToDesktop: stored.syncToDesktop === true,
    };
    if (disposed) return;
    await new Promise((resolve, reject) => {
      const error = err => { server.removeListener('listening', listening); reject(err); };
      const listening = () => { server.removeListener('error', error); port = server.address()?.port || 0; resolve(); };
      server.once('error', error);
      server.once('listening', listening);
      server.listen(0, '127.0.0.1');
    });
    if (disposed) return;
    library = await scan();
    if (disposed) return;
    const remembered = library.records.get(preference.selectedProject);
    if (remembered && preference.selectedProject !== remembered.projectPath) {
      await persist({ ...preference, selectedProject: remembered.projectPath });
    }
    if (!preference.selectedProject && preference.selectionMode === 'manual') {
      const desktop = currentDesktop(library.roots);
      const initial = desktopRecord(library, desktop?.selected) || library.items[0];
      if (initial) await persist({ ...preference, selectedProject: initial.projectPath || initial.id });
    }
    if (disposed) return;
    rebuildAllowedFiles();
    await refreshWallpaper();
  })().catch(error => {
    if (!disposed) { fail(`初始化壁纸库失败：${error.message}`); log('error', `[wallpaper-engine-live] initialization failed: ${error.stack || error.message}`); }
  });

  const enqueue = task => {
    const next = operation.catch(() => {}).then(async () => {
      await ready;
      if (disposed) throw new Error('模组已停用。');
      if (!library) throw new Error(state.error || '壁纸库尚未就绪。');
      return task();
    });
    operation = next;
    return next;
  };
  const list = (options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)) options = {};
    const query = String(options.query || '').toLocaleLowerCase().trim();
    const type = String(options.type || 'all');
    const offset = Math.max(0, Math.trunc(Number(options.offset) || 0));
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(options.limit) || 60)));
    const counts = {};
    for (const item of library.items) counts[item.type] = (counts[item.type] || 0) + 1;
    const filtered = library.items.filter(item => (!query || item.title.toLocaleLowerCase().includes(query)) && (type === 'all' || item.type === type));
    return {
      items: filtered.slice(offset, offset + limit).map(item => ({ id: item.id, projectPath: item.projectPath, title: item.title, type: item.type, mainFile: item.mainFile || item.dependency?.mainFile || null, previewPath: item.previewPath, previewUrl: registerFile(item.previewPath) })),
      total: filtered.length, libraryTotal: library.items.length, offset, limit, counts, skipped: library.skipped,
      roots: [...library.roots.workshop, ...library.roots.local],
    };
  };
  const synchronize = async projectPath => {
    assertActive();
    const result = await open(library.roots.installations, projectPath, log, { isCancelled: () => disposed });
    assertActive();
    state.syncResult = result;
    publish();
    return state.syncResult;
  };
  const selectWallpaper = async projectPath => {
    if (typeof projectPath !== 'string' || !library.records.has(projectPath)) throw new Error('请选择列表中存在的壁纸。');
    const record = library.records.get(projectPath);
    await persist({ ...preference, selectionMode: 'manual', selectedProject: record.projectPath });
    assertActive();
    state.syncResult = null;
    await applyRecord(record);
    assertActive();
    if (preference.syncToDesktop) await synchronize(record.projectPath);
    return snapshot();
  };

  api.rpc.handle('get-state', async () => { await ready; return snapshot(); });
  api.rpc.handle('list-wallpapers', options => enqueue(() => list(options)));
  api.rpc.handle('refresh-list', options => enqueue(async () => {
    const refreshed = await scan();
    assertActive();
    library = refreshed;
    rebuildAllowedFiles();
    await refreshWallpaper();
    assertActive();
    return list(options);
  }));
  api.rpc.handle('select-wallpaper', projectPath => enqueue(() => selectWallpaper(projectPath)));
  api.rpc.handle('set-mode', mode => enqueue(async () => {
    if (!['manual', 'follow'].includes(mode)) throw new Error('未知壁纸模式。');
    await persist({ ...preference, selectionMode: mode });
    assertActive();
    state.syncResult = null;
    return refreshWallpaper();
  }));
  api.rpc.handle('set-sync', enabled => enqueue(async () => {
    if (typeof enabled !== 'boolean') throw new Error('同步开关必须是布尔值。');
    await persist({ ...preference, syncToDesktop: enabled });
    assertActive();
    state.syncResult = null;
    publish();
    return snapshot();
  }));
  api.rpc.handle('step-wallpaper', direction => enqueue(async () => {
    if (direction !== 1 && direction !== -1) throw new Error('切换方向必须为 1 或 -1。');
    if (!library.items.length) throw new Error('壁纸列表为空，请先刷新列表。');
    const current = library.items.findIndex(item => item.id === selectedRecord?.id);
    const index = current < 0 ? direction > 0 ? 0 : library.items.length - 1 : (current + direction + library.items.length) % library.items.length;
    return selectWallpaper(library.items[index].projectPath);
  }));
  api.rpc.handle('refresh', () => enqueue(refreshWallpaper));
  api.rpc.handle('open-in-wallpaper-engine', projectPath => enqueue(async () => {
    const target = projectPath || selectedRecord?.projectPath;
    if (!library.records.has(target)) throw new Error('请选择列表中存在的壁纸。');
    return synchronize(library.records.get(target).projectPath);
  }));

  api.onDispose(() => {
    disposed = true;
    cancelScene();
    if (pollTimer) clearInterval(pollTimer);
    server.close();
    server.closeAllConnections?.();
    allowedFiles.clear();
    backgroundFiles.clear();
  });
  pollTimer = setInterval(() => {
    if (disposed || preference.selectionMode !== 'follow' || !library) return;
    const desktop = currentDesktop(library.roots);
    const stamp = desktop ? `${desktop.selected}:${fileStamp(desktop.configPath)}` : null;
    if (stamp !== desktopStamp) {
      desktopStamp = stamp;
      void enqueue(() => preference.selectionMode === 'follow' ? refreshWallpaper() : snapshot()).catch(error => log('warn', `[wallpaper-engine-live] desktop refresh failed: ${error.stack || error.message}`));
    }
  }, 2000);
  pollTimer.unref?.();
}

function fileStamp(file) { try { return fs.statSync(file).mtimeMs; } catch { return null; } }

module.exports = activate;
module.exports.serveFile = serveFile;
