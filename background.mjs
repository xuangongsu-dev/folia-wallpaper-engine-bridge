// Asset-only stage rendering. Scene packages and HTML are never executed here.
export function mountBackground(folium, section, container, ctx, bridge) {
  container.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;isolation:isolate;opacity:0;transition:opacity 200ms ease;background:transparent';
  const shade = document.createElement('div');
  shade.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  container.append(shade);
  let media = null;
  let mediaUrl = null;
  let mediaKind = null;
  let status = null;
  let ready = false;
  let disposed = false;
  let lastLog = '';
  let decodeError = null;

  const report = (error = decodeError) => {
    if (disposed || !media) return;
    const css = getComputedStyle(media);
    const rect = container.getBoundingClientRect();
    const ancestors = [];
    let parent = container.parentElement || container.getRootNode().host;
    let depth = 0;
    while (parent && depth++ < 24) {
      const style = getComputedStyle(parent);
      if (style.filter !== 'none' || style.backdropFilter !== 'none') ancestors.push({ element: parent.tagName, filter: style.filter, backdropFilter: style.backdropFilter });
      parent = parent.parentElement || parent.getRootNode().host;
    }
    const info = {
      title: status?.title, projectType: status?.projectType,
      sourcePath: media.dataset.sourcePath, source: status?.source,
      resolution: { width: media.naturalWidth || media.videoWidth || 0, height: media.naturalHeight || media.videoHeight || 0 },
      display: { width: rect.width, height: rect.height }, dpr: devicePixelRatio,
      filter: css.filter, objectFit: css.objectFit, transform: css.transform,
      dim: bridge.getSettings().dim, ancestorFilters: ancestors,
      limitation: status?.limitation || null, error,
    };
    bridge.reportDiagnostics(info);
    const key = JSON.stringify(info);
    if (key !== lastLog) {
      lastLog = key;
      console.info('[wallpaper-engine-live] Background source / resolution / CSS', info);
    }
  };
  const applyStyle = () => {
    const values = bridge.getSettings();
    const blur = Math.max(0, Math.min(20, values.blur));
    shade.style.background = `rgba(0,0,0,${Math.max(0, Math.min(80, values.dim)) / 100})`;
    if (media) media.style.filter = blur > 0 ? `blur(${blur}px)` : 'none';
    const playing = bridge.getPlaybackState() === 'playing';
    container.style.opacity = ready && media && (playing || values.showWhenPaused) ? '1' : '0';
    report();
  };
  const removeMedia = () => {
    ready = false;
    decodeError = null;
    if (media) {
      if (mediaKind === 'video') { media.pause(); media.removeAttribute('src'); media.load(); }
      media.remove();
    }
    media = null;
    mediaUrl = null;
    mediaKind = null;
    container.style.opacity = '0';
    bridge.reportDiagnostics(null);
  };
  const applyStatus = next => {
    if (disposed || !next) return;
    if (next.mode === 'scene-loading') return; // Keep the last frame while the scene is prepared.
    status = next;
    if (next.mode !== 'asset' || !next.assetUrl) { removeMedia(); return; }
    if (next.assetUrl === mediaUrl && next.kind === mediaKind) { applyStyle(); return; }
    removeMedia();
    const kind = next.kind === 'video' ? 'video' : 'image';
    const element = document.createElement(kind === 'video' ? 'video' : 'img');
    media = element;
    mediaKind = kind;
    mediaUrl = next.assetUrl;
    element.dataset.sourcePath = next.sourcePath || '';
    element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:none;background:#09090b';
    const onReady = () => {
      if (disposed || media !== element) return;
      ready = true;
      decodeError = null;
      applyStyle();
    };
    element.addEventListener(kind === 'video' ? 'loadeddata' : 'load', onReady, { once: true });
    element.addEventListener('error', () => {
      if (disposed || media !== element) return;
      ready = false;
      decodeError = '源媒体无法解码；没有自动用缩略图替代背景。请在 Wallpaper Engine 中打开。';
      applyStyle();
      report();
      folium.ui.toast('壁纸源媒体无法解码，可在 Wallpaper Engine 中打开。', { type: 'error' });
    }, { once: true });
    if (kind === 'video') {
      element.autoplay = true; element.loop = true; element.muted = true;
      element.playsInline = true; element.disablePictureInPicture = true;
    } else { element.alt = ''; element.decoding = 'async'; element.draggable = false; }
    container.insertBefore(element, shade);
    element.src = next.assetUrl;
    if (kind === 'video') void element.play().catch(error => {
      if (!disposed && media === element) report(error.message);
    });
    applyStyle();
  };
  const settingsDisposer = section.settings.onChange(applyStyle);
  const playbackDisposer = bridge.onPlaybackState(applyStyle);
  const stateDisposer = bridge.subscribe(applyStatus);
  const resize = new ResizeObserver(() => report());
  resize.observe(container);
  applyStyle();
  applyStatus(bridge.getState());
  return () => {
    disposed = true;
    settingsDisposer(); playbackDisposer(); stateDisposer(); resize.disconnect();
    removeMedia(); shade.remove();
  };
}
