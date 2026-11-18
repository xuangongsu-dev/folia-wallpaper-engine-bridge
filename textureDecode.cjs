'use strict';

const zlib = require('node:zlib');
const { once } = require('node:events');
const { parseTexture, decodeLz4Block, FORMAT_NAMES, MAX_PIXELS } = require('./texContainer.cjs');

// Original TEX image conversion: embedded PNG/JPEG, raw channels and BC1/2/3, without native tools.
// BC layout/interpolation: https://learn.microsoft.com/en-us/windows/win32/direct3d10/d3d10-graphics-programming-guide-resources-block-compression
// RG88 swizzle (gray=G, alpha=R): https://github.com/notscuffed/repkg/blob/master/RePKG.Application/Texture/Helpers/RG88.cs
const MAX_RGBA_BYTES = 256 * 1024 * 1024;
const MAX_ENCODED_BYTES = 256 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function problem(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 32768 || height > 32768 || width * height > MAX_PIXELS || width * height * 4 > MAX_RGBA_BYTES) {
    throw problem('texture-pixel-limit', `Texture image exceeds the pixel limit: ${width}x${height}.`);
  }
}

function imageDimensions(bytes, imageFormat) {
  if (imageFormat === 13) {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
      throw problem('texture-invalid-png', 'TEX PNG payload has no valid PNG signature/IHDR.');
    }
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    dimensions(width, height);
    return { width, height };
  }
  if (imageFormat === 2) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw problem('texture-invalid-jpeg', 'TEX JPEG payload has no JPEG signature.');
    let position = 2;
    while (position < bytes.length) {
      if (bytes[position++] !== 0xff) throw problem('texture-invalid-jpeg', 'JPEG marker is invalid.');
      while (position < bytes.length && bytes[position] === 0xff) position++;
      if (position >= bytes.length) break;
      const marker = bytes[position++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (position + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(position);
      if (length < 2 || position + length > bytes.length) throw problem('texture-invalid-jpeg', 'JPEG segment exceeds its payload.');
      if (JPEG_SOF.has(marker)) {
        if (length < 8) throw problem('texture-invalid-jpeg', 'JPEG frame header is too short.');
        const height = bytes.readUInt16BE(position + 3), width = bytes.readUInt16BE(position + 5);
        dimensions(width, height);
        return { width, height };
      }
      position += length;
    }
    throw problem('texture-invalid-jpeg', 'JPEG frame dimensions were not found before scan data.');
  }
  throw problem('texture-encoded-format-unsupported', `Unsupported TEX embedded image format: ${imageFormat}.`);
}

function colorPalette(colors, first, second, bc1) {
  const r0 = first >>> 11, g0 = (first >>> 5) & 63, b0 = first & 31;
  const r1 = second >>> 11, g1 = (second >>> 5) & 63, b1 = second & 31;
  colors[0] = (r0 << 3) | (r0 >>> 2); colors[1] = (g0 << 2) | (g0 >>> 4); colors[2] = (b0 << 3) | (b0 >>> 2); colors[3] = 255;
  colors[4] = (r1 << 3) | (r1 >>> 2); colors[5] = (g1 << 2) | (g1 >>> 4); colors[6] = (b1 << 3) | (b1 >>> 2); colors[7] = 255;
  if (bc1 && first <= second) {
    for (let channel = 0; channel < 3; channel++) { colors[8 + channel] = Math.floor((colors[channel] + colors[4 + channel]) / 2); colors[12 + channel] = 0; }
    colors[11] = 255; colors[15] = 0;
  } else {
    for (let channel = 0; channel < 3; channel++) {
      colors[8 + channel] = Math.floor((2 * colors[channel] + colors[4 + channel]) / 3);
      colors[12 + channel] = Math.floor((colors[channel] + 2 * colors[4 + channel]) / 3);
    }
    colors[11] = 255; colors[15] = 255;
  }
}

function alphaPalette(alpha, first, second) {
  alpha[0] = first; alpha[1] = second;
  if (first > second) {
    for (let i = 2; i < 8; i++) alpha[i] = Math.floor(((8 - i) * first + (i - 1) * second) / 7);
  } else {
    for (let i = 2; i < 6; i++) alpha[i] = Math.floor(((6 - i) * first + (i - 1) * second) / 5);
    alpha[6] = 0; alpha[7] = 255;
  }
}

// Decode only the logical top-left region, while retaining the full padded source row/block stride.
function decodeRawPixels(format, payload, storageWidth, storageHeight, width = storageWidth, height = storageHeight) {
  dimensions(storageWidth, storageHeight); dimensions(width, height);
  if (width > storageWidth || height > storageHeight) throw problem('texture-crop-bounds', 'Logical TEX dimensions exceed the stored mipmap.');
  const channels = format === 0 ? 4 : format === 8 ? 2 : format === 9 ? 1 : 0;
  const blockBytes = format === 7 ? 8 : format === 4 || format === 6 ? 16 : 0;
  if (!channels && !blockBytes) throw problem('texture-format-unsupported', `Unsupported TEX raw texture format ${format}; no BC7 format id is assumed.`);
  const expected = channels ? storageWidth * storageHeight * channels : Math.ceil(storageWidth / 4) * Math.ceil(storageHeight / 4) * blockBytes;
  if (payload.length !== expected) throw problem('texture-raw-length', `TEX ${FORMAT_NAMES[format]} payload has ${payload.length} bytes; expected ${expected} for ${storageWidth}x${storageHeight}.`);
  const rgba = Buffer.allocUnsafe(width * height * 4);
  if (channels) {
    for (let y = 0; y < height; y++) {
      if (format === 0) {
        payload.copy(rgba, y * width * 4, y * storageWidth * 4, y * storageWidth * 4 + width * 4);
        continue;
      }
      for (let x = 0; x < width; x++) {
        const source = (y * storageWidth + x) * channels, target = (y * width + x) * 4;
        const gray = payload[source + (format === 8 ? 1 : 0)];
        rgba[target] = gray; rgba[target + 1] = gray; rgba[target + 2] = gray;
        rgba[target + 3] = format === 8 ? payload[source] : 255;
      }
    }
    return rgba;
  }
  const blocksPerRow = Math.ceil(storageWidth / 4);
  const colors = new Uint8Array(16), alpha = new Uint8Array(8);
  for (let blockY = 0; blockY < Math.ceil(height / 4); blockY++) {
    for (let blockX = 0; blockX < Math.ceil(width / 4); blockX++) {
      const blockStart = (blockY * blocksPerRow + blockX) * blockBytes;
      const colorStart = blockStart + (format === 7 ? 0 : 8);
      colorPalette(colors, payload.readUInt16LE(colorStart), payload.readUInt16LE(colorStart + 2), format === 7);
      const colorBits = payload.readUInt32LE(colorStart + 4);
      if (format === 4) alphaPalette(alpha, payload[blockStart], payload[blockStart + 1]);
      for (let localY = 0; localY < 4; localY++) {
        const y = blockY * 4 + localY;
        if (y >= height) break;
        for (let localX = 0; localX < 4; localX++) {
          const x = blockX * 4 + localX;
          if (x >= width) break;
          const pixel = localY * 4 + localX, color = ((colorBits >>> (pixel * 2)) & 3) * 4;
          const target = (y * width + x) * 4;
          rgba[target] = colors[color]; rgba[target + 1] = colors[color + 1]; rgba[target + 2] = colors[color + 2];
          if (format === 6) rgba[target + 3] = ((payload[blockStart + (pixel >>> 1)] >>> ((pixel & 1) * 4)) & 15) * 17;
          else if (format === 4) {
            const bit = pixel * 3, byte = bit >>> 3;
            const bits = payload[blockStart + 2 + byte] | (payload[blockStart + 3 + byte] << 8);
            rgba[target + 3] = alpha[(bits >>> (bit & 7)) & 7];
          } else rgba[target + 3] = colors[color + 3];
        }
      }
    }
  }
  return rgba;
}

// PNG's IEEE CRC-32 is computed locally; no bundled image codec or native executable is used.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  CRC_TABLE[n] = crc >>> 0;
}
function crc32(bytes, initial = 0) {
  let crc = initial ^ 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(name, data) {
  const type = Buffer.from(name, 'ascii');
  const prefix = Buffer.allocUnsafe(8), tail = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(data.length, 0); type.copy(prefix, 4);
  tail.writeUInt32BE(crc32(data, crc32(type)), 0);
  return Buffer.concat([prefix, data, tail]);
}

async function encodePngRGBA(rgba, width, height) {
  dimensions(width, height);
  if (rgba.length !== width * height * 4) throw problem('png-rgba-length', 'PNG input does not match its dimensions.');
  const deflater = zlib.createDeflate({ level: 6 });
  const compressed = [];
  let compressedBytes = 0;
  let streamError = null;
  deflater.on('data', chunk => {
    compressedBytes += chunk.length;
    if (compressedBytes > MAX_ENCODED_BYTES) deflater.destroy(problem('png-output-limit', 'Encoded PNG exceeds the output limit.'));
    else compressed.push(chunk);
  });
  deflater.on('error', error => { streamError = error; });
  const finished = new Promise((resolve, reject) => { deflater.once('end', resolve); deflater.once('error', reject); });
  // Attach a rejection handler before writing rows; a stream error must never become unhandled.
  finished.catch(() => {});
  try {
    for (let y = 0; y < height; y++) {
      if (streamError) throw streamError;
      const row = Buffer.allocUnsafe(width * 4 + 1);
      row[0] = 0;
      rgba.copy(row, 1, y * width * 4, (y + 1) * width * 4);
      if (!deflater.write(row)) await once(deflater, 'drain');
    }
    deflater.end();
    await finished;
  } catch (error) { deflater.destroy(); throw error; }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), ...compressed.map(chunk => pngChunk('IDAT', chunk)), pngChunk('IEND', Buffer.alloc(0))]);
}

async function decodeTexture(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const tex = parseTexture(bytes);
  const attempts = [];
  for (let imageIndex = 0; imageIndex < tex.images.length; imageIndex++) {
    const mips = tex.images[imageIndex].mips.map((mip, mipIndex) => ({ ...mip, mipIndex })).sort((a, b) => b.width * b.height - a.width * a.height);
    for (const mip of mips) {
      try {
        const stored = bytes.subarray(mip.start, mip.start + mip.length);
        const payload = mip.lz4 ? decodeLz4Block(stored, mip.uncompressedLength) : stored;
        const common = { imageIndex, mipIndex: mip.mipIndex, container: tex.container, textureFormat: tex.header.format, imageFormat: tex.imageFormat, lz4: mip.lz4, storageWidth: mip.width, storageHeight: mip.height, declaredImageWidth: tex.header.imageWidth, declaredImageHeight: tex.header.imageHeight, staticOnly: true, orientation: 'source top-to-bottom rows preserved' };
        if (tex.imageFormat === 2 || tex.imageFormat === 13) {
          const size = imageDimensions(payload, tex.imageFormat);
          return { bytes: Buffer.from(payload), extension: tex.imageFormat === 2 ? '.jpg' : '.png', ...size, format: tex.imageFormat === 2 ? 'JPEG' : 'PNG', details: { ...common, direct: true, cropped: false, priorFailures: attempts } };
        }
        if (tex.imageFormat !== -1) throw problem('texture-encoded-format-unsupported', `Embedded ${tex.imageFormatName} texture is not supported as a static PNG/JPEG.`);
        const width = Math.min(mip.width, Math.max(1, Math.ceil(tex.header.imageWidth * mip.width / tex.header.textureWidth)));
        const height = Math.min(mip.height, Math.max(1, Math.ceil(tex.header.imageHeight * mip.height / tex.header.textureHeight)));
        const rgba = decodeRawPixels(tex.header.format, payload, mip.width, mip.height, width, height);
        const result = await encodePngRGBA(rgba, width, height);
        return { bytes: result, extension: '.png', width, height, format: FORMAT_NAMES[tex.header.format], details: { ...common, direct: false, cropped: width !== mip.width || height !== mip.height, rowStridePixels: mip.width, priorFailures: attempts } };
      } catch (error) { attempts.push({ imageIndex, mipIndex: mip.mipIndex, code: error.code || 'texture-decode-failed', error: error.message }); }
    }
  }
  const first = attempts[0];
  const error = problem(first?.code || 'texture-no-image', first?.error || 'TEX contains no usable static image.');
  error.attempts = attempts;
  throw error;
}

module.exports = { decodeTexture, decodeRawPixels, encodePngRGBA, imageDimensions, crc32, MAX_RGBA_BYTES };
