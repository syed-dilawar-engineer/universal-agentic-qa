import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';
import type { MaskRegion } from '../types.js';

/**
 * Loads a PNG from a file path or Buffer.
 */
export function loadPng(input: string | Buffer): PNG {
  const buffer = typeof input === 'string' ? fs.readFileSync(input) : input;
  return PNG.sync.read(buffer);
}

/**
 * Encodes a PNG instance to Buffer.
 */
export function writePngBuffer(png: PNG): Buffer {
  return PNG.sync.write(png);
}

/**
 * Writes a PNG instance to disk, creating parent directories if needed.
 */
export function writePngFile(filePath: string, png: PNG): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const buffer = writePngBuffer(png);
  fs.writeFileSync(filePath, buffer);
}

/**
 * Computes sha256 of a buffer.
 */
export function computeSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Normalizes two PNG images to equal dimensions by padding the smaller one
 * with transparent/neutral pixels into a common canvas of max(w1, w2) x max(h1, h2).
 */
export function normalizeImageDimensions(
  img1: PNG,
  img2: PNG
): { normalized1: PNG; normalized2: PNG; width: number; height: number; resized: boolean } {
  if (img1.width === img2.width && img1.height === img2.height) {
    return {
      normalized1: img1,
      normalized2: img2,
      width: img1.width,
      height: img1.height,
      resized: false,
    };
  }

  const maxWidth = Math.max(img1.width, img2.width);
  const maxHeight = Math.max(img1.height, img2.height);

  const padImage = (source: PNG): PNG => {
    const canvas = new PNG({ width: maxWidth, height: maxHeight });
    // Fill canvas with transparent black (0, 0, 0, 0)
    canvas.data.fill(0);

    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const srcIdx = (y * source.width + x) * 4;
        const dstIdx = (y * maxWidth + x) * 4;

        canvas.data[dstIdx] = source.data[srcIdx];
        canvas.data[dstIdx + 1] = source.data[srcIdx + 1];
        canvas.data[dstIdx + 2] = source.data[srcIdx + 2];
        canvas.data[dstIdx + 3] = source.data[srcIdx + 3];
      }
    }
    return canvas;
  };

  return {
    normalized1: padImage(img1),
    normalized2: padImage(img2),
    width: maxWidth,
    height: maxHeight,
    resized: true,
  };
}

/**
 * Applies dynamic masks to two images so that pixelmatch ignores any differences
 * within the masked bounding boxes. Copies pixel data from img1 to img2 in the mask region.
 */
export function applyRegionMasks(
  img1: PNG,
  img2: PNG,
  masks: MaskRegion[],
  width: number,
  height: number
): void {
  for (const mask of masks) {
    const startX = Math.max(0, Math.min(width, Math.floor(mask.x)));
    const startY = Math.max(0, Math.min(height, Math.floor(mask.y)));
    const endX = Math.max(0, Math.min(width, Math.ceil(mask.x + mask.width)));
    const endY = Math.max(0, Math.min(height, Math.ceil(mask.y + mask.height)));

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = (y * width + x) * 4;
        // Synchronize pixels between images so pixelmatch detects zero diff
        img2.data[idx] = img1.data[idx];
        img2.data[idx + 1] = img1.data[idx + 1];
        img2.data[idx + 2] = img1.data[idx + 2];
        img2.data[idx + 3] = img1.data[idx + 3];
      }
    }
  }
}

/**
 * Highlights masked regions in the diff image with a translucent overlay and border
 * so human reviewers know which regions were excluded.
 */
export function overlayMaskRegionsOnDiff(
  diffPng: PNG,
  masks: MaskRegion[],
  width: number,
  height: number
): void {
  for (const mask of masks) {
    const startX = Math.max(0, Math.min(width, Math.floor(mask.x)));
    const startY = Math.max(0, Math.min(height, Math.floor(mask.y)));
    const endX = Math.max(0, Math.min(width, Math.ceil(mask.x + mask.width)));
    const endY = Math.max(0, Math.min(height, Math.ceil(mask.y + mask.height)));

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const isBorder =
          x === startX || x === endX - 1 || y === startY || y === endY - 1;
        const idx = (y * width + x) * 4;

        if (isBorder) {
          // Solid light blue border: rgb(52, 152, 219)
          diffPng.data[idx] = 52;
          diffPng.data[idx + 1] = 152;
          diffPng.data[idx + 2] = 219;
          diffPng.data[idx + 3] = 255;
        } else {
          // Translucent blue tint: blend 20% blue
          diffPng.data[idx] = Math.round(diffPng.data[idx] * 0.8 + 52 * 0.2);
          diffPng.data[idx + 1] = Math.round(diffPng.data[idx + 1] * 0.8 + 152 * 0.2);
          diffPng.data[idx + 2] = Math.round(diffPng.data[idx + 2] * 0.8 + 219 * 0.2);
          diffPng.data[idx + 3] = 255;
        }
      }
    }
  }
}

/**
 * Creates a solid color PNG buffer (helpful for testing & baselines).
 */
export function createSolidColorPng(
  width: number,
  height: number,
  color: [number, number, number, number] = [255, 255, 255, 255]
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      png.data[idx] = color[0];
      png.data[idx + 1] = color[1];
      png.data[idx + 2] = color[2];
      png.data[idx + 3] = color[3];
    }
  }
  return PNG.sync.write(png);
}
