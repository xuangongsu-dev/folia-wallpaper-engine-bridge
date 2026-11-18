'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const activate = require('../main.cjs');
const { scanLibrary, resolveProjectAsset, safeFile, findSelectedWallpaper, desktopRecord } = require('../library.cjs');
const { imageHeaderSize } = require('../media.cjs');
const { openWallpaper } = require('../desktop.cjs');

// Real-file fixtures cover damaged projects, preset inheritance, resource choice and persistent RPC state.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-wallpaper-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workshop = path.join(root, '431960');
  fs.mkdirSync(workshop);
  const json = (folder, data) => {
    const directory = path.join(workshop, folder);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'project.json'), JSON.stringify(data));
    return directory;
  };
  const png = (directory, name, width, height) => {
    const file = path.join(directory, name);
    const header = Buffer.alloc(32);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    fs.writeFileSync(file, header);
    return file;
  };
  const scan = () => scanLibrary({ workshop: [workshop], local: [], installations: [], steam: [] });
  return { root, workshop, json, png, scan };
}

test('damaged JSON is skipped; preset inherits packed scene type and larger preview', async t => {
  const f = fixture(t);
  const base = f.json('100', { title: 'Scene', file: 'scene.json', preview: 'preview.png' });
  fs.writeFileSync(path.join(base, 'scene.pkg'), 'packed scene');
  f.png(base, 'preview.png', 230, 230);
  const preset = f.json('101', { title: 'Preset', dependency: '100', preview: 'preview.png' });
  f.png(preset, 'preview.png', 1024, 1024);
  const damaged = f.json('102', {});
  fs.writeFileSync(path.join(damaged, 'project.json'), '{bad');
  const library = await f.scan();
  assert.equal(library.items.length, 2);
  assert.equal(library.skipped, 1);
  const record = library.records.get(path.join(preset, 'project.json'));
  assert.equal(record.type, 'scene');
  const result = await resolveProjectAsset(record);
  assert.equal(result.asset, path.join(preset, 'preview.png'));
  assert.deepEqual(result.resolution, { width: 1024, height: 1024 });
  assert.equal(result.source, 'preview');
  assert.match(result.limitation, /未找到更大/);
});

test('existing primary image wins; missing primary uses largest usable project image, not a texture strip', async t => {
  const f = fixture(t);
  const directory = f.json('200', { type: 'scene', file: 'main.png', preview: 'preview.png' });
  const main = f.png(directory, 'main.png', 1920, 1080);
  f.png(directory, 'preview.png', 400, 400);
  const large = f.png(directory, 'background.png', 3840, 2160);
  f.png(directory, 'wave.png', 32768, 2056);
  let library = await f.scan();
  let record = library.records.get(path.join(directory, 'project.json'));
  assert.equal(record.type, 'image');
  assert.equal((await resolveProjectAsset(record)).asset, main);
  fs.unlinkSync(main);
  fs.writeFileSync(path.join(directory, 'scene.pkg'), 'packed');
  library = await f.scan();
  record = library.records.get(path.join(directory, 'project.json'));
  assert.equal(record.type, 'scene');
  const resolved = await resolveProjectAsset(record);
  assert.equal(resolved.asset, large);
  assert.equal(resolved.source, 'largest-project-resource');
});

test('web HTML is never selected as a background or executed; only its preview is returned', async t => {
  const f = fixture(t);
  const directory = f.json('300', { file: 'index.html', preview: 'preview.png' });
  fs.writeFileSync(path.join(directory, 'index.html'), '<script>throw Error("must not run")</script>');
  const preview = f.png(directory, 'preview.png', 400, 400);
  f.png(directory, 'unrelated.png', 4096, 2160);
  const record = (await f.scan()).items[0];
  assert.equal(record.type, 'web');
  const resolved = await resolveProjectAsset(record);
  assert.equal(resolved.asset, preview);
  assert.equal(resolved.source, 'preview');
  assert.match(resolved.limitation, /不执行 HTML/);
});

test('declared assets cannot escape through traversal or intermediate directory junctions', t => {
  const f = fixture(t);
  const directory = f.json('400', { title: 'Traversal' });
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  f.png(outside, 'private.png', 32, 32);
  assert.equal(safeFile(directory, '../../outside/private.png'), null);
  fs.symlinkSync(outside, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(safeFile(directory, 'linked/private.png'), null);
});

test('active wallpaperconfig takes precedence over stale recently-used selections', () => {
  const node = {
    recentlyUsed: { selectedwallpapers: { old: { file: 'old/project.json' } } },
    account: { general: { wallpaperconfig: { selectedwallpapers: { monitor: { file: 'active/project.json' } } } } },
  };
  assert.equal(findSelectedWallpaper(node), 'active/project.json');
});

test('Windows case variants resolve indexed scenes and direct videos without losing canonical project identity', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const scene = f.json('SceneCase', { title: 'Scene', file: 'scene.json', preview: 'preview.png' });
  fs.writeFileSync(path.join(scene, 'scene.pkg'), 'packed');
  f.png(scene, 'preview.png', 1024, 1024);
  const video = f.json('VideoCase', { title: 'Video', file: 'Movie.mp4', preview: 'preview.png' });
  fs.writeFileSync(path.join(video, 'Movie.mp4'), 'video');
  f.png(video, 'preview.png', 200, 200);
  const library = await f.scan();
  const scenePath = fs.realpathSync(path.join(scene, 'project.json'));
  const videoPath = fs.realpathSync(path.join(video, 'project.json'));
  assert.equal(library.records.size, 2);
  assert.equal(library.records.get(scenePath.toUpperCase()).projectPath, scenePath);
  assert.equal(desktopRecord(library, scenePath.toLowerCase()).projectPath, scenePath);
  assert.equal(desktopRecord(library, scenePath.toUpperCase()).type, 'scene');
  const fromDirectVideo = desktopRecord(library, path.join(video, 'Movie.mp4').toUpperCase());
  assert.equal(fromDirectVideo.projectPath, videoPath);
  assert.equal(fromDirectVideo.title, 'Video');
  assert.equal(fromDirectVideo.previewPath, path.join(video, 'preview.png'));
});

test('Windows saved and incoming case variants persist the list canonical path', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const directory = f.json('SavedCase', { title: 'Saved scene', file: 'scene.json', preview: 'preview.png' });
  fs.writeFileSync(path.join(directory, 'scene.pkg'), 'packed');
  f.png(directory, 'preview.png', 1024, 1024);
  const canonical = fs.realpathSync(path.join(directory, 'project.json'));
  const store = new Map([['library-selection-v1', { selectionMode: 'manual', selectedProject: canonical.toUpperCase(), syncToDesktop: false }]]);
  const handlers = new Map();
  const cleanups = [];
  activate({
    rpc: { handle: (name, handler) => handlers.set(name, handler) },
    storage: { get: async key => store.get(key), set: async (key, value) => store.set(key, value) },
    onDispose: cleanup => cleanups.push(cleanup), log: {},
  }, { scanLibrary: f.scan });
  t.after(() => cleanups.forEach(cleanup => cleanup()));
  const restored = await handlers.get('get-state')();
  assert.equal(restored.ok, true);
  assert.equal(restored.projectType, 'scene');
  assert.equal(restored.selectedProject, canonical);
  assert.equal(store.get('library-selection-v1').selectedProject, canonical);
  const selected = await handlers.get('select-wallpaper')(canonical.toLowerCase());
  assert.equal(selected.selectedProject, canonical);
  assert.equal(store.get('library-selection-v1').selectedProject, canonical);
  await handlers.get('refresh-list')();
  assert.equal((await handlers.get('get-state')()).selectedProject, canonical);
});

test('JPEG C4 is not a frame header and progressive JPEG dimensions are read correctly', t => {
  const f = fixture(t);
  const file = path.join(f.root, 'progressive.jpg');
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc2, 0x00, 0x0b, 0x08, 0x04, 0x38, 0x07, 0x80, 0x01, 0x01, 0x11, 0x00]));
  assert.deepEqual(imageHeaderSize(file), { width: 1920, height: 1080 });
});

test('manual selection persists across activation, sync failure does not break Folia, missing selections stay remembered', async t => {
  const f = fixture(t);
  const first = f.json('500', { title: 'First', file: 'main.png', preview: 'preview.png' });
  f.png(first, 'main.png', 1920, 1080); f.png(first, 'preview.png', 100, 100);
  const second = f.json('501', { title: 'Second', file: 'main.png', preview: 'preview.png' });
  f.png(second, 'main.png', 3840, 2160); f.png(second, 'preview.png', 100, 100);
  const store = new Map();
  let syncCalls = 0;
  const boot = () => {
    const handlers = new Map();
    const cleanups = [];
    activate({
      rpc: { handle: (name, handler) => handlers.set(name, handler) },
      storage: { get: async key => store.get(key), set: async (key, value) => { store.set(key, JSON.parse(JSON.stringify(value))); } },
      onDispose: cleanup => cleanups.push(cleanup), log: {},
    }, { scanLibrary: f.scan, openWallpaper: async () => { syncCalls++; return { ok: false, error: '请先启动 Wallpaper Engine' }; } });
    return { call: (name, ...args) => handlers.get(name)(...args), stop: () => cleanups.forEach(cleanup => cleanup()) };
  };
  let bridge = boot();
  t.after(() => bridge.stop());
  const initial = await bridge.call('get-state');
  assert.equal(initial.selectionMode, 'manual');
  assert.equal(initial.syncToDesktop, false);
  assert.equal((await fetch(initial.assetUrl)).status, 200);
  const assetAddress = new URL(initial.assetUrl);
  assert.equal((await fetch(`${assetAddress.origin}/health`)).status, 404);
  assert.equal((await fetch(initial.assetUrl.replace(/media\/[^?]+/, 'media/not-registered'))).status, 404);
  assert.equal((await fetch(initial.assetUrl.replace(/\/[^/]+\/media\//, '/wrong-token/media/'))).status, 404);
  const selected = await bridge.call('select-wallpaper', path.join(second, 'project.json'));
  assert.equal(selected.title, 'Second');
  assert.equal(syncCalls, 0);
  await bridge.call('set-sync', true);
  const failedSync = await bridge.call('select-wallpaper', path.join(first, 'project.json'));
  assert.equal(failedSync.ok, true);
  assert.equal(failedSync.title, 'First');
  assert.equal(failedSync.syncResult.ok, false);
  assert.equal(syncCalls, 1);
  bridge.stop();
  bridge = boot();
  const restored = await bridge.call('get-state');
  assert.equal(restored.selectedProject, path.join(first, 'project.json'));
  assert.equal(restored.syncToDesktop, true);
  assert.equal(syncCalls, 1, 'booting must not synchronize the desktop');
  await bridge.call('set-mode', 'follow');
  assert.equal((await bridge.call('set-mode', 'manual')).selectedProject, path.join(first, 'project.json'));
  fs.unlinkSync(path.join(first, 'project.json'));
  await bridge.call('refresh-list');
  const removed = await bridge.call('get-state');
  assert.equal(removed.ok, false);
  assert.equal(removed.selectedProject, path.join(first, 'project.json'));
  assert.match(removed.error, /重新选择/);
});

test('media HTTP supports HEAD and byte ranges and rejects invalid ranges', async t => {
  const f = fixture(t);
  const file = f.png(f.root, 'sample.png', 1200, 800);
  const server = http.createServer((request, response) => activate.serveFile(request, response, file));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  assert.equal((await fetch(url, { method: 'HEAD' })).headers.get('content-length'), '32');
  const partial = await fetch(url, { headers: { Range: 'bytes=2-6' } });
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, 5);
  assert.equal((await fetch(url, { headers: { Range: 'bytes=8-2' } })).status, 416);
  assert.equal((await fetch(url, { headers: { Range: 'bytes=-0' } })).status, 416);
  assert.equal((await fetch(url, { headers: { Range: 'bytes=0-1,3-4' } })).status, 416);
});

test('desktop control requires running Wallpaper Engine, uses argv for spaces and falls back to 32-bit', async t => {
  const f = fixture(t);
  const installation = path.join(f.root, 'installation with spaces');
  fs.mkdirSync(installation);
  fs.writeFileSync(path.join(installation, 'wallpaper32.exe'), 'not executed');
  const project = f.json('600', { title: 'CLI project' });
  const projectPath = path.join(project, 'project.json');
  const calls = [];
  const stopped = await openWallpaper([installation], projectPath, () => {}, {
    platform: 'win32', execute: async (...args) => { calls.push(args); return { stdout: '"explorer.exe","100"', stderr: '' }; },
  });
  assert.equal(stopped.ok, false);
  assert.match(stopped.error, /请先启动/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'tasklist.exe');
  calls.length = 0;
  const running = await openWallpaper([installation], projectPath, () => {}, {
    platform: 'win32', execute: async (...args) => { calls.push(args); return { stdout: args[0] === 'tasklist.exe' ? '"wallpaper32.exe","100"' : 'done', stderr: '' }; },
  });
  assert.equal(running.ok, true);
  assert.equal(running.exitCode, 0);
  assert.equal(running.confirmed, false);
  assert.equal(calls[1][0], path.join(installation, 'wallpaper32.exe'));
  assert.deepEqual(calls[1][1], ['-control', 'openWallpaper', '-file', projectPath]);
  assert.equal(calls[1][2].shell, false);
  assert.equal(calls[1][2].windowsHide, true);
});

test('disposing during delayed selection storage prevents background application and desktop synchronization', async t => {
  const f = fixture(t);
  const first = f.json('700', { title: 'First', file: 'main.png', preview: 'preview.png' });
  f.png(first, 'main.png', 1200, 800); f.png(first, 'preview.png', 100, 100);
  const second = f.json('701', { title: 'Second', file: 'main.png', preview: 'preview.png' });
  f.png(second, 'main.png', 1920, 1080); f.png(second, 'preview.png', 100, 100);
  const handlers = new Map();
  const cleanups = [];
  const store = new Map([['library-selection-v1', { selectionMode: 'manual', selectedProject: fs.realpathSync(path.join(first, 'project.json')), syncToDesktop: true }]]);
  let releaseStorage;
  let storageStarted;
  const started = new Promise(resolve => { storageStarted = resolve; });
  let syncCalls = 0;
  activate({
    rpc: { handle: (name, handler) => handlers.set(name, handler) },
    storage: {
      get: async key => store.get(key),
      set: async (key, value) => { storageStarted(); await new Promise(resolve => { releaseStorage = resolve; }); store.set(key, value); },
    },
    onDispose: cleanup => cleanups.push(cleanup), log: {},
  }, { scanLibrary: f.scan, openWallpaper: async () => { syncCalls++; return { ok: true }; } });
  t.after(() => cleanups.forEach(cleanup => cleanup()));
  const initial = await handlers.get('get-state')();
  const pending = handlers.get('select-wallpaper')(path.join(second, 'project.json'));
  await started;
  cleanups.forEach(cleanup => cleanup());
  releaseStorage();
  await assert.rejects(pending, /模组已停用/);
  assert.equal(syncCalls, 0);
  assert.equal((await handlers.get('get-state')()).selectedProject, initial.selectedProject);
});

test('disposing while tasklist is pending prevents the Wallpaper Engine control process from starting', async t => {
  const f = fixture(t);
  const installation = path.join(f.root, 'cancelled installation');
  fs.mkdirSync(installation);
  fs.writeFileSync(path.join(installation, 'wallpaper64.exe'), 'not executed');
  const project = f.json('800', { title: 'Cancelled' });
  const projectPath = path.join(project, 'project.json');
  let cancelled = false;
  let releaseTasklist;
  let signalTasklist;
  const started = new Promise(resolve => { signalTasklist = resolve; });
  const calls = [];
  const pending = openWallpaper([installation], projectPath, () => {}, {
    platform: 'win32', isCancelled: () => cancelled,
    execute: async (executable, ...args) => {
      calls.push([executable, ...args]);
      if (executable === 'tasklist.exe') {
        signalTasklist();
        await new Promise(resolve => { releaseTasklist = resolve; });
      }
      return { stdout: '"wallpaper64.exe","100"', stderr: '' };
    },
  });
  await started;
  cancelled = true;
  releaseTasklist();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /已取消/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'tasklist.exe');
});

test('disposing while initial scanning is pending prevents initial preference writes and asset publication', async t => {
  const f = fixture(t);
  const directory = f.json('900', { title: 'Delayed init', file: 'main.png' });
  f.png(directory, 'main.png', 1200, 800);
  const scanned = await f.scan();
  let releaseScan;
  let signalScan;
  const started = new Promise(resolve => { signalScan = resolve; });
  const handlers = new Map();
  const cleanups = [];
  let writes = 0;
  let messages = 0;
  activate({
    rpc: { handle: (name, handler) => handlers.set(name, handler), send: () => messages++ },
    storage: { get: async () => undefined, set: async () => writes++ },
    onDispose: cleanup => cleanups.push(cleanup), log: {},
  }, { scanLibrary: async () => { signalScan(); await new Promise(resolve => { releaseScan = resolve; }); return scanned; } });
  t.after(() => cleanups.forEach(cleanup => cleanup()));
  const pending = handlers.get('get-state')();
  await started;
  cleanups.forEach(cleanup => cleanup());
  releaseScan();
  await pending;
  assert.equal(writes, 0);
  assert.equal(messages, 0);
});
