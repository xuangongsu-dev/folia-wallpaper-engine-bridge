// The host-owned player panel is isolated by Folium's ShadowRoot. All project text uses textContent.
const TYPES = { video: '视频', image: '图片', scene: '场景', web: '网页', application: '程序', unknown: '未知' };

export function mountPicker(folium, container, ctx, bridge) {
  container.innerHTML = `
    <style>
      :host{color-scheme:dark} *{box-sizing:border-box}
      .wpe{height:100%;overflow:auto;padding:16px;font:13px/1.5 system-ui,sans-serif;color:var(--folium-text,#eee)}
      .wpe h2{margin:0;font-size:18px}.wpe p{margin:6px 0}.muted{opacity:.7}.toolbar{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin:10px 0}
      button,input{font:inherit;color:inherit} button{border:1px solid #ffffff30;border-radius:8px;padding:7px 10px;background:#ffffff0a;cursor:pointer}
      button:hover{background:#ffffff1d}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid #64d8bf;outline-offset:2px}button[aria-pressed=true]{border-color:#64d8bf;background:#64d8bf25}button:disabled{opacity:.45;cursor:wait}
      input[type=search]{width:100%;background:#0003;border:1px solid #ffffff30;border-radius:8px;padding:9px}label{display:flex;gap:7px;align-items:center}
      .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:10px;margin:12px 0}.card{text-align:left;padding:0;overflow:hidden;display:flex;flex-direction:column;min-width:0}
      .thumb{width:100%;aspect-ratio:16/10;object-fit:cover;background:#1e2025;display:block}.placeholder{display:grid;place-items:center;opacity:.6}
      .caption{padding:8px;width:100%}.title{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.badge{display:inline-block;font-size:11px;opacity:.7;margin-top:4px}.card[aria-pressed=true] .badge{color:#64d8bf;opacity:1}
      .notice{padding:9px;border-radius:8px;background:#ffffff09;white-space:pre-wrap;overflow-wrap:anywhere}.error{color:#ffb0a6;background:#df403018}.success{color:#8ee7b6} .current{overflow-wrap:anywhere}
      pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.55 ui-monospace,monospace;background:#0003;padding:10px;border-radius:8px}summary{cursor:pointer} .pager{justify-content:space-between}
    </style>
    <section class="wpe" data-wpe-picker>
      <h2>Wallpaper Engine 壁纸库</h2>
      <p class="muted">直接读取本机壁纸资源。默认仅切换 Folia 背景。</p>
      <div class="toolbar" role="group" aria-label="壁纸选择模式">
        <button type="button" data-mode="manual">手动选择</button><button type="button" data-mode="follow">跟随桌面壁纸</button>
      </div>
      <label><input type="checkbox" data-sync>同步到桌面</label>
      <p class="muted">打开后，点选也会切换桌面；需要 Wallpaper Engine 已运行。</p>
      <div class="toolbar"><button type="button" data-prev>上一张</button><button type="button" data-next>下一张</button><button type="button" data-refresh>刷新列表</button></div>
      <p class="current" data-current>正在读取当前壁纸…</p>
      <p class="notice" data-limitation hidden></p>
      <button type="button" data-open hidden>在 Wallpaper Engine 中打开</button>
      <p class="notice" role="status" aria-live="polite" data-message hidden></p>
      <p class="notice" role="alert" data-sync-result hidden></p>
      <div class="toolbar"><input type="search" aria-label="搜索壁纸" placeholder="搜索壁纸标题…" data-search></div>
      <div class="toolbar" role="group" aria-label="按类型筛选" data-types></div>
      <p class="muted" data-count>扫描壁纸库…</p>
      <div class="grid" data-grid></div>
      <div class="toolbar pager"><button type="button" data-page-prev>上一页</button><span data-page></span><button type="button" data-page-next>下一页</button></div>
      <details><summary>背景诊断：源文件与分辨率</summary><pre data-debug>等待背景层加载…</pre></details>
    </section>`;
  const $ = selector => container.querySelector(selector);
  const root = $('[data-wpe-picker]');
  const grid = $('[data-grid]');
  const typeBar = $('[data-types]');
  const search = $('[data-search]');
  const sync = $('[data-sync]');
  const message = $('[data-message]');
  const count = $('[data-count]');
  const pageSize = 48;
  let offset = 0;
  let type = '';
  let total = 0;
  let disposed = false;
  let request = 0;
  let debounce = null;
  let busy = false;
  let latest = bridge.getState();
  const setMessage = (text, error = false) => {
    if (disposed) return;
    message.textContent = text || '';
    message.hidden = !text;
    message.className = `notice${error ? ' error' : ''}`;
  };
  const updateDiagnostics = () => {
    if (disposed) return;
    const state = bridge.getState();
    $('[data-debug]').textContent = JSON.stringify({
      project: state?.selectedProject, type: state?.projectType,
      sourcePath: state?.sourcePath, resolution: state?.resolution,
      source: state?.source, limitation: state?.limitation, scene: state?.scene,
      rendered: bridge.getDiagnostics(),
    }, null, 2);
  };
  const updateState = state => {
    if (disposed || !state) return;
    latest = state;
    for (const button of container.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === state.selectionMode));
    sync.checked = Boolean(state.syncToDesktop);
    $('[data-current]').textContent = `${state.selectionMode === 'follow' ? '跟随桌面' : '手动选择'} · 当前：${state.title || '未选择'}${state.projectType ? ` · ${TYPES[state.projectType] || state.projectType}` : ''}`;
    $('[data-limitation]').textContent = state.limitation || '';
    $('[data-limitation]').hidden = !state.limitation;
    $('[data-limitation]').setAttribute('aria-live', state.mode === 'scene-loading' ? 'polite' : 'off');
    $('[data-open]').hidden = !state.selectedProject;
    const result = state.syncResult;
    const resultElement = $('[data-sync-result]');
    resultElement.hidden = !result;
    resultElement.className = result?.ok ? 'notice success' : 'notice error';
    resultElement.textContent = result ? (result.ok ? `桌面命令已返回（退出码 ${result.exitCode ?? 0}）。${result.message || 'Wallpaper Engine 独立渲染。'}` : `同步到桌面失败：${result.error || '未知错误'}。Folia 选择已保留。`) : '';
    for (const card of grid.querySelectorAll('[data-project]')) card.setAttribute('aria-pressed', String(card.dataset.project === state.selectedProject));
    if (state.ok === false && state.error) setMessage(state.error, true);
    updateDiagnostics();
  };
  const act = async (name, ...args) => {
    if (disposed || busy) return;
    busy = true;
    for (const button of root.querySelectorAll('button[data-mode],button[data-prev],button[data-next],button[data-open],.card')) button.disabled = true;
    sync.disabled = true;
    setMessage('');
    try {
      const result = await bridge.action(name, ...args);
      if (!disposed && result?.ok === false) setMessage(result.error || '操作失败', true);
      if (!disposed && result?.syncResult?.ok === false) folium.ui.toast(result.syncResult.error, { type: 'error' });
    } catch (error) { setMessage(error.message, true); }
    finally {
      busy = false;
      if (!disposed) {
        for (const button of root.querySelectorAll('button[data-mode],button[data-prev],button[data-next],button[data-open],.card')) button.disabled = false;
        sync.disabled = false;
        updateState(bridge.getState());
      }
    }
  };
  const makeTypeButton = (key, title, number) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${title}${number === undefined ? '' : ` ${number}`}`;
    button.setAttribute('aria-pressed', String(type === key));
    button.addEventListener('click', () => { type = key; offset = 0; void load(); });
    typeBar.append(button);
  };
  const load = async (refresh = false) => {
    const version = ++request;
    $('[data-refresh]').disabled = true;
    try {
      if (refresh) await folium.rpc.call('refresh-list');
      const result = await folium.rpc.call('list-wallpapers', { offset, limit: pageSize, query: search.value.trim(), type });
      if (disposed || version !== request) return;
      total = result.total;
      grid.replaceChildren();
      typeBar.replaceChildren();
      makeTypeButton('', '全部');
      for (const [key, label] of Object.entries(TYPES)) if (result.counts?.[key]) makeTypeButton(key, label, result.counts[key]);
      count.textContent = `找到 ${total} 项 · 损坏/不可读项目跳过 ${result.skipped ?? 0} 项`;
      for (const item of result.items || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'card';
        button.dataset.project = item.projectPath;
        button.disabled = busy;
        button.title = `${item.title}\n${item.projectPath}`;
        button.setAttribute('aria-pressed', String(item.projectPath === latest?.selectedProject));
        if (item.previewUrl) {
          const image = document.createElement('img');
          image.className = 'thumb'; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.src = item.previewUrl;
          image.addEventListener('error', () => { image.alt = '无可用预览'; }, { once: true });
          button.append(image);
        } else {
          const placeholder = document.createElement('span');
          placeholder.className = 'thumb placeholder'; placeholder.textContent = '无预览'; button.append(placeholder);
        }
        const caption = document.createElement('span'); caption.className = 'caption';
        const title = document.createElement('span'); title.className = 'title'; title.textContent = item.title;
        const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = `${TYPES[item.type] || '未知'} · ${item.type}`;
        caption.append(title, badge); button.append(caption);
        button.addEventListener('click', () => { void act('select-wallpaper', item.projectPath); });
        grid.append(button);
      }
      if (!result.items?.length) { const empty = document.createElement('p'); empty.textContent = '没有匹配的壁纸。可修改搜索或刷新列表。'; grid.append(empty); }
      $('[data-page]').textContent = `${Math.floor(offset / pageSize) + 1} / ${Math.max(1, Math.ceil(total / pageSize))}`;
      $('[data-page-prev]').disabled = offset === 0;
      $('[data-page-next]').disabled = offset + pageSize >= total;
      if (refresh) { setMessage('壁纸列表已刷新'); await bridge.poll(); }
    } catch (error) { if (!disposed && version === request) setMessage(error.message, true); }
    finally { if (!disposed && version === request) $('[data-refresh]').disabled = false; }
  };
  for (const button of container.querySelectorAll('[data-mode]')) button.addEventListener('click', () => { void act('set-mode', button.dataset.mode); });
  sync.addEventListener('change', () => { void act('set-sync', sync.checked); });
  $('[data-prev]').addEventListener('click', () => { void act('step-wallpaper', -1); });
  $('[data-next]').addEventListener('click', () => { void act('step-wallpaper', 1); });
  $('[data-refresh]').addEventListener('click', () => { offset = 0; void load(true); });
  $('[data-open]').addEventListener('click', () => { if (latest?.selectedProject) void act('open-in-wallpaper-engine', latest.selectedProject); });
  $('[data-page-prev]').addEventListener('click', () => { offset = Math.max(0, offset - pageSize); void load(); });
  $('[data-page-next]').addEventListener('click', () => { offset += pageSize; void load(); });
  search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => { offset = 0; void load(); }, 180); });
  const stateDisposer = bridge.subscribe(updateState);
  const diagnosticDisposer = bridge.subscribeDiagnostics(updateDiagnostics);
  const libraryDisposer = bridge.subscribeLibrary(() => { offset = 0; void load(); });
  updateState(latest);
  void load();
  return () => { disposed = true; ++request; clearTimeout(debounce); stateDisposer(); diagnosticDisposer(); libraryDisposer(); container.replaceChildren(); };
}
