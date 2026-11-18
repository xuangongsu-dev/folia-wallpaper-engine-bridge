'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { safeFile } = require('./library.cjs');

const CACHE_LIMIT = 384 * 1024 * 1024;
const PACKAGE_LIMIT = 1024 * 1024 * 1024;
const CACHE_AGE = 30 * 24 * 60 * 60 * 1000;
const WORKER_TIMEOUT = 60_000;
const CACHE_NAME = /^scene-[\w-]{1,40}-[a-f0-9]{32}\.(?:json|jpg|png)$/;
const WORKING_NAME = /^working-[a-z0-9]{6}$/i;
const WORKING_FILES = ['scene.pkg', 'image.jpg', 'image.png', 'result.json'];

function scenePackage(record) {
  const visited = new Set();
  for (let current = record; current && !visited.has(current); current = current.dependency) {
    visited.add(current);
    if (current.mainFile && /\.pkg$/i.test(current.mainFile)) {
      const candidate = safeFile(current.directory, path.relative(current.directory, current.mainFile));
      if (candidate) return candidate;
    }
    const defaultPackage = safeFile(current.directory, 'scene.pkg');
    if (defaultPackage) return defaultPackage;
  }
  return null;
}

function checkSignal(signal) { signal?.throwIfAborted(); }

function runWorker(workerData, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'sceneWorker.cjs'), { workerData });
    let result;
    let failure;
    const stop = error => {
      failure ??= error;
      void worker.terminate().catch(() => {});
    };
    const cancel = () => stop(signal.reason || new Error('Scene selection changed'));
    const timeout = setTimeout(() => stop(new Error('scene-worker-timeout')), WORKER_TIMEOUT);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.once('message', message => {
      if (message.error) failure ??= new Error(message.error);
      else result = message.value;
    });
    worker.once('error', error => { failure ??= error; });
    worker.once('exit', code => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new Error(`scene-worker-exit-${code}`));
      else resolve(result);
    });
    if (signal?.aborted) cancel();
  });
}

async function fileInfo(file) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch { return null; }
}

async function clearWorkingDirectory(directory) {
  for (const name of WORKING_FILES) await fs.unlink(path.join(directory, name)).catch(() => {});
  await fs.rmdir(directory).catch(() => {});
}

async function pruneCache(root, protectedKey) {
  const groups = new Map();
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    if (item.isDirectory() && WORKING_NAME.test(item.name)) {
      const directory = path.join(root, item.name);
      const stat = await fs.lstat(directory).catch(() => null);
      if (stat?.isDirectory() && !stat.isSymbolicLink() && stat.mtimeMs < Date.now() - 24 * 60 * 60 * 1000) {
        await clearWorkingDirectory(directory);
      }
      continue;
    }
    if (!item.isFile() || !CACHE_NAME.test(item.name)) continue;
    const file = path.join(root, item.name);
    const stat = await fileInfo(file);
    if (!stat) continue;
    const key = path.basename(item.name, path.extname(item.name));
    const group = groups.get(key) || { key, files: [], bytes: 0, touched: 0 };
    group.files.push(file);
    group.bytes += stat.size;
    group.touched = Math.max(group.touched, stat.mtimeMs);
    groups.set(key, group);
  }
  let bytes = [...groups.values()].reduce((total, group) => total + group.bytes, 0);
  const expiry = Date.now() - CACHE_AGE;
  for (const group of [...groups.values()].sort((a, b) => a.touched - b.touched)) {
    if (group.key === protectedKey || (group.touched >= expiry && bytes <= CACHE_LIMIT)) continue;
    for (const file of group.files) await fs.unlink(file).catch(() => {});
    bytes -= group.bytes;
  }
}

async function readCache(root, key) {
  const file = path.join(root, key + '.json');
  const stat = await fileInfo(file);
  if (!stat || stat.size > 128 * 1024 || stat.mtimeMs < Date.now() - CACHE_AGE) return null;
  let result;
  try { result = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
  if (result?.reason && !result.extension) return result;
  if (!['.jpg', '.png'].includes(result?.extension) || !Number.isInteger(result.width) || result.width < 1 || !Number.isInteger(result.height) || result.height < 1) return null;
  const asset = path.join(root, key + result.extension);
  const imageStat = await fileInfo(asset);
  if (!imageStat || imageStat.size !== result.imageBytes) return null;
  const now = new Date();
  await fs.utimes(file, now, now).catch(() => {});
  return { ...result, asset };
}

async function getSceneImage(cacheDirectory, record, pkgPath, preview, signal) {
  checkSignal(signal);
  const source = await fileInfo(pkgPath);
  if (!source || source.size > PACKAGE_LIMIT) return { reason: 'package-size-limit', packagePath: pkgPath };
  const root = path.join(cacheDirectory, 'scene-textures-v1');
  await fs.mkdir(root, { recursive: true });
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('invalid-scene-cache-directory');
  const signature = file => [file.size, file.mtimeMs, file.ctimeMs].join(':');
  const identifier = path.basename(record.directory).replace(/[^\w-]/g, '_').slice(0, 40) || 'local';
  const digest = createHash('sha256').update(JSON.stringify([pkgPath, signature(source), preview ?? null])).digest('hex').slice(0, 32);
  const key = `scene-${identifier}-${digest}`;
  const cached = await readCache(root, key);
  checkSignal(signal);
  if (cached) {
    await pruneCache(root, key);
    return { ...cached, packagePath: pkgPath, cache: 'hit' };
  }
  const temporary = await fs.mkdtemp(path.join(root, 'working-'));
  const copy = path.join(temporary, 'scene.pkg');
  try {
    await fs.copyFile(pkgPath, copy);
    checkSignal(signal);
    const afterCopy = await fileInfo(pkgPath);
    if (!afterCopy || signature(source) !== signature(afterCopy)) throw new Error('scene-package-changed-during-copy');
    const result = await runWorker({ temporary, copy, preview }, signal);
    checkSignal(signal);
    let asset = null;
    if (result.extension) {
      const image = path.join(temporary, 'image' + result.extension);
      const imageStat = await fs.stat(image);
      if (imageStat.size >= CACHE_LIMIT - 128 * 1024) throw new Error('scene-image-cache-size-limit');
      result.imageBytes = imageStat.size;
      asset = path.join(root, key + result.extension);
      await fs.rename(image, asset);
    }
    const json = path.join(temporary, 'result.json');
    await fs.writeFile(json, JSON.stringify(result), { flag: 'wx' });
    await fs.rename(json, path.join(root, key + '.json'));
    await pruneCache(root, key);
    return { ...result, asset, packagePath: pkgPath, cache: 'miss' };
  } finally {
    await clearWorkingDirectory(temporary);
  }
}

module.exports = { scenePackage, getSceneImage };
