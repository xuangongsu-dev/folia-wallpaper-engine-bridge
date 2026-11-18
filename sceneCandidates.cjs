'use strict';

const { openPackage, normalizeEntryName, MAX_ENTRY_BYTES } = require('./pkgReader.cjs');
const { parseTexture, MAX_DECODED_BYTES } = require('./texContainer.cjs');

const auxiliary = /(?:^|[/_.\s-])(?:mask\d*|normal\d*|depth|particle\w*|sprite\w*|fireworks?|noise\d*|lut|roughness|specular|opacity|alpha|flowmap|displacement|distortion|watermark|tooltip)(?:$|[/_.\s-])|烟花|粒子|遮罩|蒙版|法线|提示框|白底|水印/i;
const background = /(?:^|[/_.\s-])(?:background\d*|backdrop|bg\d*|bijing|base|wallpaper)(?:$|[/_.\s-])|背景|底图/i;
const rawFormats = new Set([0, 4, 6, 7]); // R8/RG88 are normally auxiliary channels rather than background color.

function lookup(pkg, name) {
  try { return pkg.getEntry(normalizeEntryName(name)); } catch { return null; }
}

async function json(pkg, name) {
  const entry = lookup(pkg, name);
  if (!entry) return null;
  try { return await pkg.readJson(entry.name); } catch { return null; }
}

function textureEntry(pkg, reference) {
  if (typeof reference !== 'string' || !reference) return null;
  const stem = reference.replace(/\.tex$/i, '').replaceAll('\\', '/');
  return lookup(pkg, stem + '.tex') || lookup(pkg, 'materials/' + stem + '.tex');
}

function sizePair(value) {
  const vector = Array.isArray(value) ? value : typeof value === 'string' ? value.trim().split(/\s+/) : [];
  return vector.slice(0, 2).map(Number);
}

async function sceneLayers(pkg) {
  const scene = await json(pkg, 'scene.json');
  const refs = new Map();
  const objects = Array.isArray(scene?.objects) ? scene.objects.slice(0, 10000) : [];
  const byId = new Map(objects.map(object => [object?.id, object]));
  const visible = object => {
    const parents = new Set();
    while (object && !parents.has(object)) {
      parents.add(object);
      if (object.visible === false || object.visible?.value === false) return false;
      object = object.parent == null ? null : byId.get(object.parent);
    }
    return true;
  };
  let layerOrder = 0;
  for (const object of objects) {
    if (typeof object?.image !== 'string') continue;
    const order = layerOrder++;
    const model = await json(pkg, object.image);
    const material = typeof model?.material === 'string' ? await json(pkg, model.material) : model?.material;
    const layer = { name: String(object.name ?? object.id ?? object.image).slice(0, 200), order, visible: visible(object), size: sizePair(object.size), model: object.image, material: typeof model?.material === 'string' ? model.material : null };
    const passes = Array.isArray(material?.passes) ? material.passes.slice(0, 64) : [];
    for (const pass of passes) {
      const textures = pass?.textures;
      const primary = Array.isArray(textures) ? textures[0] : textures?.[0];
      const entry = textureEntry(pkg, primary);
      if (entry) {
        const previous = refs.get(entry.name);
        if (!previous || (!previous.visible && layer.visible)) refs.set(entry.name, layer);
      }
    }
  }
  return { refs, imageLayers: layerOrder, totalObjects: objects.length };
}

// Approximate the source detail that survives a centered 16:9 cover crop.
const coverDetail = (width, height) => Math.min(width, height * (16 / 9));

async function inspectScenePackage(copyPath, preview) {
  const pkg = await openPackage(copyPath);
  try {
    const layers = await sceneLayers(pkg);
    const textures = [];
    const candidates = [];
    const previewDetail = preview ? coverDetail(preview.width, preview.height) : 0;
    for (const entry of pkg.entries) {
      if (!/\.tex$/i.test(entry.name)) continue;
      let tex;
      let prefix;
      try {
        prefix = await pkg.readEntry(entry, { prefixBytes: 4096 });
        tex = parseTexture(prefix, { metadataOnly: true, totalLength: entry.length });
      } catch (error) {
        textures.push({ name: entry.name, bytes: entry.length, error: error.code || error.message });
        continue;
      }
      const mip = tex.images[0].mips[0];
      const payload = mip.lz4 ? null : prefix.subarray(mip.start, Math.min(mip.start + mip.length, mip.start + 16));
      const video = tex.isMp4 || payload?.toString('ascii', 4, 8) === 'ftyp';
      const embedded = tex.imageFormat === 2 || tex.imageFormat === 13;
      const width = embedded ? mip.width : Math.min(tex.header.imageWidth, mip.width);
      const height = embedded ? mip.height : Math.min(tex.header.imageHeight, mip.height);
      const layer = layers.refs.get(entry.name) || null;
      const format = video ? 'MP4（TEX 内嵌）' : tex.imageFormat === -1 ? tex.header.formatName : tex.imageFormatName;
      const detail = coverDetail(width, height);
      const knownColor = embedded || (tex.imageFormat === -1 && rawFormats.has(tex.header.format));
      const ratio = width / height;
      let excluded = null;
      if (video) excluded = 'embedded-video';
      else if (!knownColor) excluded = 'unsupported-color-format';
      else if (entry.length > MAX_ENTRY_BYTES || mip.uncompressedLength > MAX_DECODED_BYTES) excluded = 'decode-size-limit';
      else if (width < 768 || height < 480 || width * height < 480000 || ratio > 5 || ratio < 0.35) excluded = 'small-or-atlas';
      else if (tex.imageCount > 1 || auxiliary.test(entry.name) || (layer && auxiliary.test(layer.name))) excluded = 'auxiliary-texture';
      else if (layer?.visible === false) excluded = 'hidden-layer';
      else if (detail <= previewDetail) excluded = 'no-detail-gain';
      const item = {
        name: entry.name, bytes: entry.length, format, width, height,
        paddedWidth: mip.width, paddedHeight: mip.height, lz4: mip.lz4,
        layer, visible: layer?.visible ?? null, excluded,
      };
      textures.push(item);
      if (excluded) continue;
      const components = {
        pixels: Math.log2(width * height / 480000) * 22,
        aspect: 26 * Math.max(0, 1 - Math.abs(Math.log2(ratio / (16 / 9)))),
        bottom: layer?.visible ? 26 / (1 + layer.order * 0.35) : 0,
        name: background.test(entry.name) || (layer && background.test(layer.name)) ? 14 : 0,
      };
      const score = Number(Object.values(components).reduce((sum, value) => sum + value, 0).toFixed(2));
      candidates.push({ ...item, score, components, detail, preferred: layer?.visible === true });
    }
    const ranked = candidates.filter(item => item.preferred).sort((a, b) => b.score - a.score || b.detail - a.detail || a.name.localeCompare(b.name));
    const remaining = candidates.filter(item => !item.preferred && item.visible !== false).sort((a, b) => b.width * b.height - a.width * a.height || a.name.localeCompare(b.name));
    return {
      package: { magic: pkg.magic, bytes: pkg.size, entries: pkg.entries },
      scene: { imageLayers: layers.imageLayers, totalObjects: layers.totalObjects },
      textures, candidates: [...ranked, ...remaining],
    };
  } finally { await pkg.close(); }
}

module.exports = { inspectScenePackage, coverDetail };
