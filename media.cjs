'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Read media dimensions without transcoding or loading a complete video into memory.
const execute = promisify(execFile);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.wmv']);
const CONTENT_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.mp4': 'video/mp4',
  '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv',
};
const cache = new Map();
const isImage = file => IMAGE_EXTENSIONS.has(path.extname(file || '').toLowerCase());
const isVideo = file => VIDEO_EXTENSIONS.has(path.extname(file || '').toLowerCase());

function imageHeaderSize(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const bytes = Buffer.alloc(Math.min(fs.fstatSync(descriptor).size, 256 * 1024));
    fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (bytes.length >= 24 && bytes.toString('ascii', 1, 4) === 'PNG') {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'GIF') {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (bytes.length >= 26 && bytes.toString('ascii', 0, 2) === 'BM') {
      return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
    }
    if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
      const type = bytes.toString('ascii', 12, 16);
      if (type === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
      if (type === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      }
      if (type === 'VP8L' && bytes[20] === 0x2f) {
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
      while (offset + 8 < bytes.length) {
        if (bytes[offset++] !== 0xff) continue;
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
        const length = bytes.readUInt16BE(offset);
        if (length < 2) break;
        if (sof.has(marker)) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
        offset += length;
      }
    }
  } catch {
    // Corrupt or unsupported files can still be probed by ffprobe, then by the browser.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return null;
}

async function mediaSize(file) {
  try {
    const stat = await fs.promises.stat(file);
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    if (cache.get(file)?.stamp === stamp) return cache.get(file).size;
    let size = isImage(file) ? imageHeaderSize(file) : null;
    if (!size) {
      try {
        const { stdout } = await execute('ffprobe.exe', [
          '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
          '-of', 'json', file,
        ], { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 128 * 1024 });
        const stream = JSON.parse(stdout).streams?.[0];
        if (stream?.width > 0 && stream?.height > 0) size = { width: stream.width, height: stream.height };
      } catch {
        // ffprobe is optional. The client logs naturalWidth/videoWidth after decoding.
      }
    }
    if (cache.size > 4096) cache.clear();
    cache.set(file, { stamp, size });
    return size;
  } catch { return null; }
}

module.exports = { isImage, isVideo, imageHeaderSize, mediaSize, CONTENT_TYPES };
