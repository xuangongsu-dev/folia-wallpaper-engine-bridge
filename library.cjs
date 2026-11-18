'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isImage, isVideo, mediaSize } = require('./media.cjs');

// Discover only existing Steam libraries; Wallpaper Engine and Workshop files stay read-only.
function pathKey(file) {
  if (typeof file !== 'string') return file;
  const absolute = path.resolve(file);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

// Windows config paths may differ in case from directory listings; values retain display paths.
class ProjectPathMap extends Map {
  get(file) { return super.get(pathKey(file)); }
  has(file) { return super.has(pathKey(file)); }
  set(file, value) { return super.set(pathKey(file), value); }
  delete(file) { return super.delete(pathKey(file)); }
}

function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function steamRoots() {
  const roots = new Set();
  const seeds = [path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam')];
  for (const drive of ['C:', 'D:', 'E:', 'F:', 'G:', 'H:']) {
    for (const suffix of ['Steam', 'SteamLibrary', 'Program Files (x86)\\Steam', 'Program Files\\Steam', 'Games\\Steam']) seeds.push(path.join(drive, suffix));
  }
  for (const seed of seeds) {
    if (!fs.existsSync(seed)) continue;
    roots.add(path.resolve(seed));
    try {
      const text = fs.readFileSync(path.join(seed, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
        const library = path.normalize(match[1].replaceAll('\\\\', '\\'));
        if (fs.existsSync(library)) roots.add(library);
      }
    } catch { /* A missing or malformed library file affects only that root. */ }
  }
  return [...roots];
}

function discoveryRoots() {
  const steam = steamRoots();
  const installations = steam.map(root => path.join(root, 'steamapps', 'common', 'wallpaper_engine')).filter(root => fs.existsSync(root));
  const workshop = steam.map(root => path.join(root, 'steamapps', 'workshop', 'content', '431960')).filter(root => fs.existsSync(root));
  const local = installations.map(root => path.join(root, 'projects')).filter(root => fs.existsSync(root));
  return { steam, installations, workshop, local };
}

function safeFile(directory, relative) {
  if (typeof relative !== 'string' || !relative.trim() || relative.includes('\0') || path.isAbsolute(relative)) return null;
  const result = path.resolve(directory, relative);
  const rel = path.relative(directory, result);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    const stat = fs.lstatSync(result);
    const actual = path.relative(fs.realpathSync(directory), fs.realpathSync(result));
    return stat.isFile() && !stat.isSymbolicLink() && actual && !actual.startsWith('..') && !path.isAbsolute(actual) ? result : null;
  } catch { return null; }
}

function previewIn(directory, declared) {
  for (const name of [declared, 'preview.jpg', 'preview.png', 'preview.webp', 'preview.gif', 'preview.jpeg', 'preview.avif']) {
    const file = safeFile(directory, name);
    if (file && isImage(file)) return file;
  }
  return null;
}

function classify(project, directory) {
  const declared = typeof project.file === 'string' ? project.file : '';
  const file = safeFile(directory, declared);
  if (file && isVideo(file)) return 'video';
  if (file && isImage(file)) return 'image';
  const ext = path.extname(declared).toLowerCase();
  if (file && ['.html', '.htm'].includes(ext)) return 'web';
  if (file && ['.exe', '.bat', '.cmd', '.com'].includes(ext)) return 'application';
  if ((ext === '.pkg' && file) || (ext === '.json' && file) || safeFile(directory, 'scene.pkg')) return 'scene';
  // Some projects use a packed web payload. Never treat its HTML as a media source.
  const type = String(project.type || '').toLowerCase();
  if (type === 'web') return 'web';
  if (isVideo(declared)) return 'video';
  if (isImage(declared)) return 'image';
  return ['scene', 'application'].includes(type) ? type : 'unknown';
}

async function projectFiles(root, maxDepth = 12) {
  const files = [];
  async function walk(directory, depth) {
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'project.json') files.push(file);
      else if (entry.isDirectory() && depth < maxDepth) await walk(file, depth + 1);
    }
  }
  await walk(root, 0);
  return files;
}

async function scanLibrary(roots = discoveryRoots()) {
  const files = new Set();
  for (const root of roots.workshop) {
    let entries;
    try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const file = path.join(root, entry.name, 'project.json');
      if (fs.existsSync(file)) files.add(file);
    }
  }
  for (const root of roots.local) for (const file of await projectFiles(root)) files.add(file);
  const records = new ProjectPathMap();
  let skipped = 0;
  for (const file of files) {
    const project = readJson(file);
    if (!project) { skipped++; continue; }
    let projectPath;
    try { projectPath = fs.realpathSync(file); } catch { skipped++; continue; }
    const directory = path.dirname(projectPath);
    records.set(projectPath, {
      id: projectPath, projectPath, directory, project,
      title: typeof project.title === 'string' && project.title.trim() ? project.title.trim() : path.basename(directory),
      type: classify(project, directory), mainFile: safeFile(directory, project.file) || safeFile(directory, 'scene.pkg'),
      previewPath: previewIn(directory, project.preview), dependency: null,
    });
  }
  for (const record of records.values()) {
    const dependency = String(record.project.dependency || '');
    if (!/^\d+$/.test(dependency)) continue;
    record.dependency = records.get(path.join(path.dirname(record.directory), dependency, 'project.json'))
      || [...records.values()].find(candidate => path.basename(candidate.directory) === dependency) || null;
    if (record.dependency && record.type === 'unknown') record.type = record.dependency.type;
  }
  const items = [...records.values()].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN', { numeric: true }) || a.id.localeCompare(b.id));
  return { items, records, skipped, roots };
}

function findSelectedWallpaper(node) {
  if (!node || typeof node !== 'object') return null;
  // Account.general.wallpaperconfig is active state; history also contains selectedwallpapers.
  if (node.general?.wallpaperconfig) {
    const selected = findSelectedWallpaper(node.general.wallpaperconfig);
    if (selected) return selected;
  }
  if (node.wallpaperconfig) {
    const selected = findSelectedWallpaper(node.wallpaperconfig);
    if (selected) return selected;
  }
  for (const value of Object.values(node)) {
    if (!value?.general?.wallpaperconfig) continue;
    const selected = findSelectedWallpaper(value.general.wallpaperconfig);
    if (selected) return selected;
  }
  if (node.selectedwallpapers && typeof node.selectedwallpapers === 'object') {
    for (const entry of Object.values(node.selectedwallpapers)) if (typeof entry?.file === 'string') return entry.file;
  }
  for (const value of Object.values(node)) {
    const selected = findSelectedWallpaper(value);
    if (selected) return selected;
  }
  return null;
}

function currentDesktop(roots) {
  for (const installation of roots.installations) {
    const configPath = path.join(installation, 'config.json');
    const config = readJson(configPath);
    const selected = findSelectedWallpaper(config);
    if (selected) return { selected: path.normalize(selected), configPath, installation };
  }
  return null;
}

function desktopRecord(library, selected) {
  if (!selected) return null;
  const absolute = path.resolve(selected);
  if (library.records.has(absolute)) return library.records.get(absolute);
  const sibling = path.join(path.dirname(absolute), 'project.json');
  if (library.records.has(sibling)) return library.records.get(sibling);
  // Wallpaper Engine can select a direct media file outside the indexed projects.
  if ((isImage(absolute) || isVideo(absolute)) && fs.existsSync(absolute)) {
    return { id: absolute, projectPath: null, directory: path.dirname(absolute), project: {}, title: path.basename(absolute), type: isVideo(absolute) ? 'video' : 'image', mainFile: absolute, previewPath: null, dependency: null };
  }
  return null;
}

async function mediaFiles(directory) {
  const output = [];
  let seen = 0;
  async function walk(root, depth) {
    let entries;
    try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++seen > 12000) return;
      if (entry.isSymbolicLink()) continue;
      const file = path.join(root, entry.name);
      if (entry.isFile() && (isImage(file) || isVideo(file))) output.push(file);
      else if (entry.isDirectory() && depth < 8) await walk(file, depth + 1);
    }
  }
  await walk(directory, 0);
  return output;
}

async function resolveProjectAsset(record, { sceneBackgroundOnly = false } = {}) {
  const dependency = record.dependency;
  const previews = [...new Set([record.previewPath, dependency?.previewPath].filter(Boolean))];
  let asset = null;
  let source = null;
  // HTML is never served/executed, even if a web project's other files look like assets.
  if (record.type !== 'web') {
    for (const candidate of [record.mainFile, dependency?.mainFile]) {
      if (candidate && (isImage(candidate) || isVideo(candidate)) && fs.existsSync(candidate)) { asset = candidate; source = 'original'; break; }
    }
  }
  const previewSizes = await Promise.all(previews.map(async file => ({ file, size: await mediaSize(file) })));
  previewSizes.sort((a, b) => area(b.size) - area(a.size));
  if (!asset && record.type !== 'web') {
    const candidates = [];
    for (const directory of [...new Set([record.directory, dependency?.directory].filter(Boolean))]) {
      for (const file of await mediaFiles(directory)) {
        if (previews.includes(file) || /^preview\./i.test(path.basename(file))) continue;
        if (sceneBackgroundOnly && record.type === 'scene' && /(?:^|[_.\s-])(?:normal|mask|depth|displacement|particle|lut)(?:[_.\s-]|$)/i.test(path.basename(file))) continue;
        const size = await mediaSize(file);
        // Very long texture strips/sprite atlases are renderer inputs, not full-frame backgrounds.
        if (size && (size.width / size.height > 5 || size.height / size.width > 5 || Math.max(size.width, size.height) > 16384)) continue;
        candidates.push({ file, size });
      }
    }
    candidates.sort((a, b) => area(b.size) - area(a.size) || backgroundRank(b.file) - backgroundRank(a.file) || a.file.localeCompare(b.file));
    // A scene's scattered textures can be tiny icons. Use them only when larger than its preview.
    const largest = candidates[0];
    if (largest && area(largest.size) >= area(previewSizes[0]?.size) && area(largest.size) > 0) { asset = largest.file; source = 'largest-project-resource'; }
  }
  if (!asset) { asset = previewSizes[0]?.file || null; source = 'preview'; }
  const resolution = asset ? await mediaSize(asset) : null;
  let limitation = null;
  if (record.type === 'scene') limitation = source === 'preview'
    ? '场景动画由 Wallpaper Engine 专用渲染器处理。项目中未找到更大的可用普通媒体，Folia 仅显示预览图（可能放大模糊）；可在 Wallpaper Engine 中打开以完整渲染。'
    : 'Folia 仅显示场景项目中的普通图片/视频资源，不复现粒子、交互、着色器或场景动画；可在 Wallpaper Engine 中打开以完整渲染。';
  if (record.type === 'web') limitation = '网页壁纸仅显示预览，不执行 HTML/JavaScript；请使用“在 Wallpaper Engine 中打开”。';
  if (record.type === 'application') limitation = '程序壁纸不会在 Folia 内执行；当前仅显示项目中的普通图片/视频或预览。';
  if (source === 'preview' && !limitation) limitation = '主文件不可用，当前仅显示项目预览。';
  return { asset, poster: record.previewPath || dependency?.previewPath || null, resolution, source, limitation, kind: isVideo(asset) ? 'video' : 'image' };
}

function area(size) { return size ? size.width * size.height : 0; }
function backgroundRank(file) {
  const name = path.basename(file).toLowerCase();
  return (/background|combined|base|wallpaper|beach|wall_/.test(name) ? 2 : 0)
    - (/normal|mask|depth|alpha|overlay|palms|foreground/.test(name) ? 2 : 0);
}

module.exports = { readJson, steamRoots, discoveryRoots, safeFile, previewIn, classify, scanLibrary, currentDesktop, desktopRecord, resolveProjectAsset, findSelectedWallpaper };
