'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openPackage, normalizeEntryName } = require('../pkgReader.cjs');

// Minimal archive fixtures verify the parser independently of the user's live Workshop library.
const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value >>> 0); return bytes; };
const string = value => { const bytes = Buffer.from(value); return Buffer.concat([u32(bytes.length), bytes]); };
function archive(entries, patch = {}) {
  let offset = 0;
  const index = [string('PKGV0015'), u32(entries.length)];
  for (const entry of entries) {
    index.push(string(entry.name), u32(entry.offset ?? offset), u32(entry.length ?? entry.data.length));
    offset += entry.data.length;
  }
  return Buffer.concat([...index, ...entries.map(entry => entry.data), ...(patch.trailing ? [patch.trailing] : [])]);
}
async function copiedFile(t, bytes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-pkg-reader-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^folia-pkg-reader-test-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const file = path.join(root, 'copied-scene.pkg');
  await fs.writeFile(file, bytes);
  return file;
}

test('PKG metadata index, relative offsets, UTF-8 names and targeted reads agree', async t => {
  const scene = Buffer.from('{"objects":[{"name":"背景"}]}');
  const texture = Buffer.from([1, 2, 3, 4, 5, 6]);
  const file = await copiedFile(t, archive([{ name: 'scene.json', data: scene }, { name: 'materials/背景.tex', data: texture }]));
  const pkg = await openPackage(file);
  try {
    assert.equal(pkg.magic, 'PKGV0015');
    assert.equal(pkg.count, 2);
    assert.equal(pkg.entries[0].start, pkg.dataStart);
    assert.equal(pkg.entries[1].start, pkg.dataStart + scene.length);
    assert.deepEqual((await pkg.readJson('SCENE.JSON')).objects, [{ name: '背景' }]);
    assert.deepEqual(await pkg.readEntry('MATERIALS\\背景.TEX', { prefixBytes: 3 }), Buffer.from([1, 2, 3]));
    await assert.rejects(pkg.readEntry('materials/背景.tex', { maxBytes: 5 }), { code: 'pkg-entry-limit' });
    await assert.rejects(pkg.readEntry({ name: 'scene.json', start: 0, length: 4 }), { code: 'pkg-entry-not-found' });
    assert.equal(await pkg.readJson('absent.json', { optional: true }), null);
  } finally { await pkg.close(); }
  await assert.rejects(pkg.readEntry('scene.json'), { code: 'pkg-closed' });
  await pkg.close();
});

test('PKG path traversal, Windows aliases and case-colliding names are rejected', async t => {
  for (const name of ['../outside.png', '/absolute.png', 'C:\\outside.png', 'folder/../outside', 'folder//empty', 'folder/NUL.png', 'folder/name.']) assert.throws(() => normalizeEntryName(name), { code: 'pkg-unsafe-path' });
  const file = await copiedFile(t, archive([{ name: 'scene.json', data: Buffer.from('{}') }, { name: 'SCENE.JSON', data: Buffer.from('{}') }]));
  await assert.rejects(openPackage(file), { code: 'pkg-duplicate-path' });
});

test('PKG truncated entries, invalid UTF-8 names and oversized index fields fail safely', async t => {
  const bounds = await copiedFile(t, archive([{ name: 'scene.json', data: Buffer.from('{}'), length: 1000 }]));
  await assert.rejects(openPackage(bounds), { code: 'pkg-entry-bounds' });
  const invalidUtf8 = Buffer.concat([string('PKGV0015'), u32(1), u32(1), Buffer.from([0xff]), u32(0), u32(0)]);
  await assert.rejects(openPackage(await copiedFile(t, invalidUtf8)), { code: 'pkg-invalid-utf8' });
  const largeName = Buffer.concat([string('PKGV0015'), u32(1), u32(0xffffffff)]);
  await assert.rejects(openPackage(await copiedFile(t, largeName)), { code: 'pkg-string-limit' });
});

test('PKG JSON decoding rejects malformed bytes and enforces its independent size bound', async t => {
  const file = await copiedFile(t, archive([{ name: 'broken.json', data: Buffer.from('{bad') }, { name: 'utf8.json', data: Buffer.from([0xff]) }]));
  const pkg = await openPackage(file);
  try {
    await assert.rejects(pkg.readJson('broken.json'), { code: 'pkg-invalid-json' });
    await assert.rejects(pkg.readJson('utf8.json'), { code: 'pkg-invalid-json' });
    await assert.rejects(pkg.readJson('broken.json', { maxBytes: 1 }), { code: 'pkg-entry-limit' });
  } finally { await pkg.close(); }
});
