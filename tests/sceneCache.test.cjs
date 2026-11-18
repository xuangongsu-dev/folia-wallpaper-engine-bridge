'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const { getSceneImage } = require('../sceneCache.cjs');
const { encodePngRGBA } = require('../textureDecode.cjs');

const uint32 = number => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(number);
  return bytes;
};
const string = value => Buffer.concat([uint32(Buffer.byteLength(value)), Buffer.from(value)]);
const json = value => Buffer.from(JSON.stringify(value));

function makePackage(files) {
  let offset = 0;
  const entries = Object.entries(files).map(([name, bytes]) => {
    const entry = Buffer.concat([string(name), uint32(offset), uint32(bytes.length)]);
    offset += bytes.length;
    return entry;
  });
  return Buffer.concat([string('PKGV0015'), uint32(entries.length), ...entries, ...Object.values(files)]);
}

async function texPng(width, height, imageCount = 1) {
  const png = await encodePngRGBA(Buffer.alloc(width * height * 4, 255), width, height);
  const image = Buffer.concat([...([1, width, height, 0, 0, png.length].map(uint32)), png]);
  return Buffer.concat([
    Buffer.from('TEXV0005\0TEXI0001\0'), ...[0, 0, width, height, width, height, 0].map(uint32),
    Buffer.from('TEXB0003\0'), uint32(imageCount), uint32(13), ...Array(imageCount).fill(image),
  ]);
}

test('scene worker skips hidden and particle layers, caches by package stamp and cleans its copy', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-scene-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'workshop', '1234');
  const cache = path.join(root, 'cache');
  await fs.mkdir(directory, { recursive: true });
  const pkg = path.join(directory, 'scene.pkg');
  const background = await texPng(1024, 576);
  const atlas = await texPng(1280, 800, 2);
  const hidden = await texPng(1920, 1080);
  const files = {
    'scene.json': json({ objects: [
      { name: 'hidden', image: 'models/hidden.json', visible: { value: false } },
      { name: '烟花', image: 'models/sparks.json' },
      { name: '背景', image: 'models/background.json' },
    ] }),
    'models/hidden.json': json({ material: 'materials/hidden.json' }),
    'models/sparks.json': json({ material: 'materials/sparks.json' }),
    'models/background.json': json({ material: 'materials/background.json' }),
    'materials/hidden.json': json({ passes: [{ textures: ['hidden'] }] }),
    'materials/sparks.json': json({ passes: [{ textures: ['sparks'] }] }),
    'materials/background.json': json({ passes: [{ textures: ['background'] }] }),
    'materials/hidden.tex': hidden,
    'materials/sparks.tex': atlas,
    'materials/background.tex': background,
  };
  const original = makePackage(files);
  await fs.writeFile(pkg, original);
  const initialStat = await fs.stat(pkg);
  const preview = { width: 256, height: 256 };
  const first = await getSceneImage(cache, { directory }, pkg, preview);
  assert.equal(first.cache, 'miss');
  assert.equal(first.texture, 'materials/background.tex');
  assert.equal(first.layer, '背景');
  assert.ok(Number.isFinite(first.score));
  assert.ok(first.scores.aspect > 0 && first.scores.bottom > 0);
  assert.deepEqual([first.width, first.height], [1024, 576]);
  const second = await getSceneImage(cache, { directory }, pkg, preview);
  assert.equal(second.cache, 'hit');
  assert.equal(second.asset, first.asset);
  assert.deepEqual(await fs.readFile(pkg), original);
  assert.equal((await fs.stat(pkg)).mtimeMs, initialStat.mtimeMs);
  const cacheRoot = path.dirname(first.asset);
  assert.equal((await fs.readdir(cacheRoot)).some(name => name.startsWith('working-')), false);
  const earlier = new Date(initialStat.mtimeMs - 2000);
  await fs.utimes(pkg, earlier, earlier);
  const changed = await getSceneImage(cache, { directory }, pkg, preview);
  assert.equal(changed.cache, 'miss');
  assert.notEqual(changed.asset, first.asset);
});
