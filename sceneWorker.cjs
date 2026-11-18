'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { openPackage } = require('./pkgReader.cjs');
const { inspectScenePackage, coverDetail } = require('./sceneCandidates.cjs');
const { decodeTexture } = require('./textureDecode.cjs');

async function extract({ copy, temporary, preview }) {
  const inventory = await inspectScenePackage(copy, preview);
  const errors = [];
  const pkg = await openPackage(copy);
  try {
    for (const candidate of inventory.candidates.slice(0, 24)) {
      let decoded;
      try {
        decoded = await decodeTexture(await pkg.readEntry(candidate.name));
      } catch (error) {
        errors.push({ name: candidate.name, reason: String(error.code || error.message).slice(0, 180) });
        continue;
      }
      if (preview && coverDetail(decoded.width, decoded.height) <= coverDetail(preview.width, preview.height)) {
        errors.push({ name: candidate.name, reason: 'no-detail-gain' });
        continue;
      }
      if (!['.jpg', '.png'].includes(decoded.extension)) throw new Error('Unexpected decoded image extension');
      await fs.writeFile(path.join(temporary, 'image' + decoded.extension), decoded.bytes, { flag: 'wx' });
      return {
        extension: decoded.extension, width: decoded.width, height: decoded.height,
        format: decoded.format, texture: candidate.name, layer: candidate.layer?.name ?? null,
        score: candidate.score, scores: candidate.components, layerOrder: candidate.layer?.order ?? null,
        selection: candidate.preferred ? 'scene-layer' : 'largest-available',
        lz4: candidate.lz4, errors,
      };
    }
    const exclusions = {};
    for (const texture of inventory.textures) {
      const reason = texture.excluded || texture.error;
      if (reason) exclusions[reason] = (exclusions[reason] || 0) + 1;
    }
    return { reason: errors.length ? 'texture-decode-failed' : 'no-large-texture', exclusions, errors };
  } finally { await pkg.close(); }
}

if (parentPort) {
  extract(workerData).then(
    value => parentPort.postMessage({ value }),
    error => parentPort.postMessage({ error: String(error.code || error.message).slice(0, 400) }),
  );
}

module.exports = { extract };
