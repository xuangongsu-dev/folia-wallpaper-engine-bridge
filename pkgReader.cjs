'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

// Original read-only PKG reader. The caller supplies a cache copy, never a live Workshop file.
// Layout cross-checked against real PKGV0015 bytes and RePKG's documented reader:
// https://github.com/notscuffed/repkg/blob/master/RePKG.Application/Package/PackageReader.cs
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const MAX_NAME_BYTES = 4096;
const decoder = new TextDecoder('utf-8', { fatal: true });

function problem(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeEntryName(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_NAME_BYTES) throw problem('pkg-unsafe-path', 'Invalid PKG entry name length.');
  const name = value.replaceAll('\\', '/').normalize('NFC');
  if (name.startsWith('/') || path.win32.isAbsolute(name) || /[:<>"|?*\x00-\x1f]/.test(name)) throw problem('pkg-unsafe-path', `Unsafe PKG entry path: ${JSON.stringify(value)}`);
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw problem('pkg-unsafe-path', `Unsafe PKG entry path: ${JSON.stringify(value)}`);
  return name;
}

function entryKey(value) { return normalizeEntryName(value).toLowerCase(); }

// A small buffer prevents one filesystem operation per integer while retaining bounded index reads.
class IndexReader {
  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
    this.position = 0;
    this.cache = Buffer.alloc(0);
    this.cacheStart = 0;
  }
  async take(length) {
    const end = this.position + length;
    if (!Number.isSafeInteger(length) || length < 0 || end > this.size) throw problem('pkg-truncated-index', 'PKG index exceeds the copied file.');
    if (end > MAX_INDEX_BYTES) throw problem('pkg-index-limit', `PKG index exceeds ${MAX_INDEX_BYTES} bytes.`);
    if (this.position < this.cacheStart || end > this.cacheStart + this.cache.length) {
      const count = Math.min(Math.max(64 * 1024, length), this.size - this.position, MAX_INDEX_BYTES - this.position);
      const buffer = Buffer.allocUnsafe(count);
      let read = 0;
      while (read < count) {
        const result = await this.handle.read(buffer, read, count - read, this.position + read);
        if (!result.bytesRead) throw problem('pkg-truncated-index', 'PKG copy changed or ended while reading the index.');
        read += result.bytesRead;
      }
      this.cacheStart = this.position;
      this.cache = buffer;
    }
    const value = this.cache.subarray(this.position - this.cacheStart, end - this.cacheStart);
    this.position = end;
    return value;
  }
  async uint32() { return (await this.take(4)).readUInt32LE(0); }
  async string(maximum) {
    const length = await this.uint32();
    if (length > maximum) throw problem('pkg-string-limit', `PKG string exceeds ${maximum} bytes.`);
    try { return decoder.decode(await this.take(length)); }
    catch (error) {
      if (error.code?.startsWith('pkg-')) throw error;
      throw problem('pkg-invalid-utf8', 'PKG entry contains invalid UTF-8.');
    }
  }
}

async function openPackage(file) {
  const handle = await fs.open(file, 'r');
  let closed = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 16) throw problem('pkg-invalid-file', 'PKG copy is not a regular, complete package.');
    const reader = new IndexReader(handle, stat.size);
    const magic = await reader.string(32);
    if (!/^PKGV\d{4}$/.test(magic)) throw problem('pkg-unknown-magic', `Unsupported PKG signature: ${JSON.stringify(magic)}`);
    const count = await reader.uint32();
    if (count > MAX_ENTRIES) throw problem('pkg-entry-limit', `PKG contains too many entries: ${count}.`);
    const entries = [];
    const byName = new Map();
    for (let i = 0; i < count; i++) {
      const originalName = await reader.string(MAX_NAME_BYTES);
      const name = normalizeEntryName(originalName);
      const key = name.toLowerCase();
      if (byName.has(key)) throw problem('pkg-duplicate-path', `Duplicate or case-colliding PKG entry: ${JSON.stringify(name)}`);
      const entry = { name, originalName, offset: await reader.uint32(), length: await reader.uint32(), start: 0 };
      entries.push(entry);
      byName.set(key, entry);
    }
    const dataStart = reader.position;
    for (const entry of entries) {
      entry.start = dataStart + entry.offset;
      if (!Number.isSafeInteger(entry.start + entry.length) || entry.start + entry.length > stat.size) throw problem('pkg-entry-bounds', `PKG entry exceeds the copied file: ${JSON.stringify(entry.name)}`);
      Object.freeze(entry);
    }
    Object.freeze(entries);
    const getEntry = name => byName.get(entryKey(name)) || null;
    const readEntry = async (entryOrName, options = {}) => {
      if (closed) throw problem('pkg-closed', 'PKG reader is closed.');
      if (!options || typeof options !== 'object') throw problem('pkg-invalid-options', 'Invalid PKG read options.');
      const entry = typeof entryOrName === 'string' ? getEntry(entryOrName) : entryOrName;
      if (!entry || byName.get(entryKey(entry.name)) !== entry) throw problem('pkg-entry-not-found', `Entry not found in this PKG: ${JSON.stringify(typeof entryOrName === 'string' ? entryOrName : entryOrName?.name)}`);
      const maximum = options.maxBytes === undefined ? MAX_ENTRY_BYTES : options.maxBytes;
      if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_ENTRY_BYTES) throw problem('pkg-entry-limit', `PKG read limit must be between 0 and ${MAX_ENTRY_BYTES}.`);
      const prefix = options.prefixBytes;
      if (prefix !== undefined && (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > MAX_ENTRY_BYTES)) throw problem('pkg-entry-limit', 'Invalid PKG metadata prefix size.');
      const length = prefix === undefined ? entry.length : Math.min(entry.length, prefix);
      if (length > maximum) throw problem('pkg-entry-limit', `PKG entry read exceeds ${maximum} bytes: ${entry.name}`);
      const output = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        if (closed) throw problem('pkg-closed', 'PKG reader is closed.');
        const result = await handle.read(output, read, length - read, entry.start + read);
        if (!result.bytesRead) throw problem('pkg-truncated-entry', `PKG copy ended while reading ${entry.name}.`);
        read += result.bytesRead;
      }
      return output;
    };
    const readJson = async (name, options = {}) => {
      if (!getEntry(name) && options.optional === true) return null;
      const requested = options.maxBytes === undefined ? MAX_JSON_BYTES : options.maxBytes;
      const buffer = await readEntry(name, { maxBytes: Math.min(MAX_JSON_BYTES, requested) });
      try { return JSON.parse(decoder.decode(buffer).replace(/^\uFEFF/, '')); }
      catch { throw problem('pkg-invalid-json', `Invalid UTF-8 JSON in PKG entry: ${name}`); }
    };
    return {
      file, size: stat.size, magic, count, dataStart, entries, getEntry, readEntry, readJson,
      async close() { if (!closed) { closed = true; await handle.close(); } },
    };
  } catch (error) {
    closed = true;
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readPackageIndex(file) {
  const pkg = await openPackage(file);
  try { return { file: pkg.file, size: pkg.size, magic: pkg.magic, count: pkg.count, dataStart: pkg.dataStart, entries: pkg.entries }; }
  finally { await pkg.close(); }
}

module.exports = { openPackage, readPackageIndex, normalizeEntryName, MAX_ENTRY_BYTES, MAX_JSON_BYTES };
