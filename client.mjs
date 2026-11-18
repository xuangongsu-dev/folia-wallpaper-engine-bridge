const buildQuery = new URL(import.meta.url).search;
const { mountBackground } = await import(`./background.mjs${buildQuery}`);
const { mountPicker } = await import(`./picker.mjs${buildQuery}`);

// Folium 1.6 client: one shared RPC poller serves the player layer and library panel.
const DEFAULT_SETTINGS = Object.freeze({ dim: 18, blur: 0, showWhenPaused: true });

export default function activate(folium) {
  if (!folium.registries.stageLayers || !folium.rpc || !folium.registries.playerPanelTabs) {
    throw new Error('wallpaper-engine-live requires Folium 1.6 or newer');
  }
  const section = folium.registries.settingsSections.register({
    id: 'appearance',
    label: { 'zh-CN': '壁纸外观', en: 'Wallpaper appearance' },
    description: { 'zh-CN': '原始媒体以 cover 铺满；模糊默认关闭。壁纸库在播放页「壁纸库」标签，也可用命令「浏览 Wallpaper Engine 壁纸」。', en: 'Original media with cover fit. Blur is off by default. Open the Wallpaper library player tab to browse.' },
    settings: [
      { key: 'dim', type: 'number', label: { 'zh-CN': '暗化', en: 'Dim' }, description: { 'zh-CN': '0 为原始亮度，80 为明显变暗。', en: '0 keeps the original brightness; 80 darkens strongly.' }, defaultValue: 18, min: 0, max: 80, step: 1 },
      { key: 'blur', type: 'number', label: { 'zh-CN': '模糊', en: 'Blur' }, description: { 'zh-CN': '像素值；只有主动调大时才模糊。', en: 'Pixels; applied only when you increase this value.' }, defaultValue: 0, min: 0, max: 20, step: 1 },
      { key: 'showWhenPaused', type: 'boolean', label: { 'zh-CN': '暂停时保留壁纸', en: 'Keep wallpaper while paused' }, description: { 'zh-CN': '关闭后暂停或停止播放时回到 Folia 原背景。', en: 'When off, pause or stop restores Folia’s background.' }, defaultValue: true },
    ],
  });
  const listeners = new Set();
  const diagnosticListeners = new Set();
  const libraryListeners = new Set();
  let state = null;
  let diagnostics = null;
  let disposed = false;
  let polling = false;
  let actionTail = Promise.resolve();
  let playbackState = 'stopped';
  const playbackListeners = new Set();
  try { playbackState = folium.playback.getState().state; } catch { /* State events still update it. */ }
  const notify = () => { for (const listener of listeners) listener(state); };
  const update = next => {
    if (!disposed && next && (!state || (next.revision ?? 0) >= (state.revision ?? 0))) { state = next; notify(); }
    return next;
  };
  const bridge = {
    getState: () => state,
    getDiagnostics: () => diagnostics,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeDiagnostics(listener) { diagnosticListeners.add(listener); return () => diagnosticListeners.delete(listener); },
    subscribeLibrary(listener) { libraryListeners.add(listener); return () => libraryListeners.delete(listener); },
    notifyLibrary() { for (const listener of libraryListeners) listener(); },
    reportDiagnostics(next) { diagnostics = next; for (const listener of diagnosticListeners) listener(next); },
    getPlaybackState: () => playbackState,
    onPlaybackState(listener) { playbackListeners.add(listener); return () => playbackListeners.delete(listener); },
    getSettings() {
      const values = section.settings.get();
      return {
        dim: Number.isFinite(Number(values.dim)) ? Number(values.dim) : DEFAULT_SETTINGS.dim,
        blur: Number.isFinite(Number(values.blur)) ? Number(values.blur) : DEFAULT_SETTINGS.blur,
        showWhenPaused: typeof values.showWhenPaused === 'boolean' ? values.showWhenPaused : true,
      };
    },
    // Serialize actions so rapid clicks cannot overwrite a newer selection with an old response.
    action(name, ...args) {
      const run = actionTail.then(async () => {
        const result = await folium.rpc.call(name, ...args);
        if (name === 'open-in-wallpaper-engine') await bridge.poll();
        else if (result && 'selectionMode' in result) update(result);
        return result;
      });
      actionTail = run.catch(() => {});
      return run;
    },
    async poll() {
      if (disposed || polling) return;
      polling = true;
      try { update(await folium.rpc.call('get-state')); }
      catch (error) { console.warn('[wallpaper-engine-live] Wallpaper state unavailable', error); }
      finally { polling = false; }
    },
  };
  const playbackDisposer = folium.events.on('playback.stateChanged', ({ state: next }) => {
    playbackState = next;
    for (const listener of playbackListeners) listener();
  });
  const toast = (message, type = 'info') => folium.ui.toast(message, { type });
  const command = (id, zh, en, run) => folium.registries.commands.register({
    id, label: { 'zh-CN': zh, en },
    run: async () => {
      try {
        const result = await run();
        if (result?.syncResult?.ok === false) toast(result.syncResult.error, 'error');
        else if (result?.ok === false) toast(result.error || '没有找到可用的壁纸', 'error');
        else if (result?.mode === 'scene-loading') toast(`正在读取场景底图：${result.title}`);
        else if (result?.title) toast(`已切换：${result.title}`, 'success');
        return { message: result?.error || result?.title || '完成' };
      } catch (error) { toast(error.message, 'error'); throw error; }
    },
  });
  command('browse', '浏览 Wallpaper Engine 壁纸', 'Browse Wallpaper Engine wallpapers', () => folium.ui.openPlayerPanel('library'));
  command('previous', '上一张壁纸', 'Previous wallpaper', () => bridge.action('step-wallpaper', -1));
  command('next', '下一张壁纸', 'Next wallpaper', () => bridge.action('step-wallpaper', 1));
  command('refresh-list', '刷新壁纸列表', 'Refresh wallpaper library', async () => {
    const result = await folium.rpc.call('refresh-list');
    bridge.notifyLibrary();
    toast(`壁纸列表已刷新：${result.total} 项，跳过 ${result.skipped} 项`, 'success');
    await bridge.poll();
    return result;
  });
  command('follow', '跟随当前桌面壁纸', 'Follow current desktop wallpaper', () => bridge.action('set-mode', 'follow'));
  command('refresh', '刷新 Wallpaper Engine 壁纸', 'Refresh Wallpaper Engine wallpaper', () => bridge.action('refresh'));
  folium.registries.playerPanelTabs.register({
    id: 'library', label: { 'zh-CN': '壁纸库', en: 'Wallpaper library' }, order: 180,
    mount: (container, ctx) => mountPicker(folium, container, ctx, bridge),
  });
  folium.registries.stageLayers.register({
    id: 'wallpaper-background', slot: 'player.stage.back', order: 80, interactive: false,
    mount: (container, ctx) => mountBackground(folium, section, container, ctx, bridge),
  });
  void bridge.poll();
  const timer = setInterval(() => { void actionTail.then(() => bridge.poll()); }, 2000);
  folium.onDispose(() => {
    disposed = true;
    clearInterval(timer);
    playbackDisposer();
    listeners.clear();
    playbackListeners.clear();
    diagnosticListeners.clear();
    libraryListeners.clear();
  });
}
