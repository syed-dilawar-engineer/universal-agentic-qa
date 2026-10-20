import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PNG } from 'pngjs';
import { VisualDiffEngine } from '../visual-diff.js';
import { createSolidColorPng, loadPng } from '../utils/image.js';
import { FindingSchema, EvidenceArtifactSchema } from '@agentic-qa/schemas';

describe('VisualDiffEngine', () => {
  let engine: VisualDiffEngine;
  let tempDir: string;

  beforeEach(() => {
    engine = new VisualDiffEngine({ defaultDiffThreshold: 0.01 }); // 1% default
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-diff-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Identical & Perceptual Diffing', () => {
    it('passes with 0% mismatch for identical images', async () => {
      const whiteImage = createSolidColorPng(100, 100, [255, 255, 255, 255]);
      const result = await engine.compareBuffers(whiteImage, whiteImage);

      expect(result.passed).toBe(true);
      expect(result.mismatchPixels).toBe(0);
      expect(result.mismatchPercentage).toBe(0);
      expect(result.totalPixels).toBe(10000);
      expect(result.baselineCreated).toBe(false);
      expect(result.finding).toBeUndefined();
    });

    it('fails when pixel mismatch exceeds threshold', async () => {
      // Create baseline: 100x100 white
      const baseline = createSolidColorPng(100, 100, [255, 255, 255, 255]);

      // Create candidate: 100x100 white with a 20x20 red square in the center (400 mismatched pixels = 4%)
      const candidatePng = new PNG({ width: 100, height: 100 });
      candidatePng.data.fill(255); // Fill with white
      for (let y = 40; y < 60; y++) {
        for (let x = 40; x < 60; x++) {
          const idx = (y * 100 + x) * 4;
          candidatePng.data[idx] = 255;   // R
          candidatePng.data[idx + 1] = 0; // G
          candidatePng.data[idx + 2] = 0; // B
          candidatePng.data[idx + 3] = 255;
        }
      }
      const candidate = PNG.sync.write(candidatePng);

      const result = await engine.compareBuffers(baseline, candidate, {
        diffThreshold: 0.01, // 1% threshold
      });

      expect(result.passed).toBe(false);
      expect(result.mismatchPercentage).toBeGreaterThanOrEqual(3.5);
      expect(result.mismatchPixels).toBeGreaterThanOrEqual(350);
      expect(result.totalPixels).toBe(10000);

      // Verify diff image buffer is generated
      expect(result.diffImageBuffer).toBeDefined();
      expect(result.diffImageBuffer!.length).toBeGreaterThan(0);

      // Verify diff image highlights mismatches in red ([255, 0, 0])
      const diffPng = loadPng(result.diffImageBuffer!);
      const centerPixelIdx = (50 * 100 + 50) * 4;
      expect(diffPng.data[centerPixelIdx]).toBe(255); // Red
      expect(diffPng.data[centerPixelIdx + 1]).toBe(0);
      expect(diffPng.data[centerPixelIdx + 2]).toBe(0);

      // Verify structured Finding adheres to schema
      expect(result.finding).toBeDefined();
      const parsedFinding = FindingSchema.safeParse(result.finding);
      expect(parsedFinding.success).toBe(true);

      // Verify EvidenceArtifact adheres to schema
      expect(result.evidenceArtifact).toBeDefined();
      const parsedEvidence = EvidenceArtifactSchema.safeParse(result.evidenceArtifact);
      expect(parsedEvidence.success).toBe(true);
    });

    it('passes when mismatch is within custom tolerance threshold', async () => {
      const baseline = createSolidColorPng(100, 100, [255, 255, 255, 255]);

      // 10x10 square = 100 pixels = 1.0% of 10000 pixels
      const candidatePng = new PNG({ width: 100, height: 100 });
      candidatePng.data.fill(255);
      for (let y = 10; y < 20; y++) {
        for (let x = 10; x < 20; x++) {
          const idx = (y * 100 + x) * 4;
          candidatePng.data[idx] = 0;
          candidatePng.data[idx + 1] = 0;
          candidatePng.data[idx + 2] = 0;
          candidatePng.data[idx + 3] = 255;
        }
      }
      const candidate = PNG.sync.write(candidatePng);

      // Set diffThreshold to 0.02 (2.0% tolerance)
      const result = await engine.compareBuffers(baseline, candidate, {
        diffThreshold: 0.02,
      });

      expect(result.passed).toBe(true);
      expect(result.mismatchRatio).toBeLessThanOrEqual(0.02);
      expect(result.finding).toBeUndefined();
    });
  });

  describe('Dynamic Region Masking', () => {
    it('masks dynamic regions (timestamps, animated banners, avatars)', async () => {
      const baseline = createSolidColorPng(100, 100, [255, 255, 255, 255]);

      // Candidate has differences in three dynamic regions:
      // 1. Timestamp at (10, 10, 30, 10)
      // 2. Banner at (0, 70, 100, 20)
      // 3. Avatar at (70, 10, 20, 20)
      const candidatePng = new PNG({ width: 100, height: 100 });
      candidatePng.data.fill(255);

      // Stamp region 1: timestamp
      for (let y = 10; y < 20; y++) {
        for (let x = 10; x < 40; x++) {
          const idx = (y * 100 + x) * 4;
          candidatePng.data[idx] = 100;
          candidatePng.data[idx + 1] = 100;
          candidatePng.data[idx + 2] = 100;
        }
      }
      // Stamp region 2: banner
      for (let y = 70; y < 90; y++) {
        for (let x = 0; x < 100; x++) {
          const idx = (y * 100 + x) * 4;
          candidatePng.data[idx] = 50;
        }
      }
      // Stamp region 3: avatar
      for (let y = 10; y < 30; y++) {
        for (let x = 70; x < 90; x++) {
          const idx = (y * 100 + x) * 4;
          candidatePng.data[idx + 1] = 150;
        }
      }
      const candidate = PNG.sync.write(candidatePng);

      // Without masks: should fail
      const unmaskedResult = await engine.compareBuffers(baseline, candidate, {
        diffThreshold: 0.01,
      });
      expect(unmaskedResult.passed).toBe(false);
      expect(unmaskedResult.mismatchPixels).toBeGreaterThan(1000);

      // With dynamic masks: should completely ignore the differences and pass
      const timestampMask = engine.createTimestampMask(10, 10, 30, 10);
      const bannerMask = engine.createBannerMask(0, 70, 100, 20);
      const avatarMask = engine.createAvatarMask(70, 10, 20, 20);

      const maskedResult = await engine.compareBuffers(baseline, candidate, {
        diffThreshold: 0.01,
        masks: [timestampMask, bannerMask, avatarMask],
      });

      expect(maskedResult.passed).toBe(true);
      expect(maskedResult.mismatchPixels).toBe(0);
      expect(maskedResult.mismatchPercentage).toBe(0);
      expect(maskedResult.maskedRegions.length).toBe(3);
    });
  });

  describe('Baseline Guarantees & Missing Image Handling', () => {
    it('NEVER marks as PASSED if candidate image is missing', async () => {
      const baselinePath = path.join(tempDir, 'baseline.png');
      const candidatePath = path.join(tempDir, 'non-existent-candidate.png');

      fs.writeFileSync(baselinePath, createSolidColorPng(50, 50));

      const result = await engine.compareFiles(baselinePath, candidatePath);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('Candidate image does not exist');
      expect(result.finding).toBeDefined();
    });

    it('NEVER auto-approves new baselines without explicit updateBaselines flag', async () => {
      const baselinePath = path.join(tempDir, 'new-baseline.png');
      const candidatePath = path.join(tempDir, 'candidate.png');

      fs.writeFileSync(candidatePath, createSolidColorPng(50, 50));

      // Attempt comparison without updateBaselines flag
      const result = await engine.compareFiles(baselinePath, candidatePath, {
        updateBaselines: false,
      });

      expect(result.passed).toBe(false);
      expect(result.baselineCreated).toBe(false);
      expect(fs.existsSync(baselinePath)).toBe(false);
      expect(result.error).toContain('Baseline image does not exist');
      expect(result.error).toContain('--update-baselines');
    });

    it('creates new baseline when updateBaselines flag is explicitly set', async () => {
      const baselinePath = path.join(tempDir, 'subfolder', 'baseline.png');
      const candidatePath = path.join(tempDir, 'candidate.png');

      fs.writeFileSync(candidatePath, createSolidColorPng(60, 60, [100, 200, 50, 255]));

      const result = await engine.compareFiles(baselinePath, candidatePath, {
        updateBaselines: true,
      });

      expect(result.passed).toBe(true);
      expect(result.baselineCreated).toBe(true);
      expect(fs.existsSync(baselinePath)).toBe(true);
      expect(result.mismatchPercentage).toBe(0);

      // Subsequent comparison against newly created baseline should pass without updateBaselines
      const secondRun = await engine.compareFiles(baselinePath, candidatePath, {
        updateBaselines: false,
      });
      expect(secondRun.passed).toBe(true);
      expect(secondRun.baselineCreated).toBe(false);
    });

    it('NEVER marks as PASSED for empty image buffers', async () => {
      const validBuffer = createSolidColorPng(50, 50);
      const emptyBuffer = Buffer.alloc(0);

      const res1 = await engine.compareBuffers(emptyBuffer, validBuffer);
      expect(res1.passed).toBe(false);
      expect(res1.error).toContain('Baseline image buffer is empty');

      const res2 = await engine.compareBuffers(validBuffer, emptyBuffer);
      expect(res2.passed).toBe(false);
      expect(res2.error).toContain('Candidate image buffer is empty');
    });
  });

  describe('Dimension Mismatches & Output Writing', () => {
    it('handles image dimension differences gracefully without throwing', async () => {
      // 50x50 baseline vs 50x70 candidate
      const baseline = createSolidColorPng(50, 50, [255, 255, 255, 255]);
      const candidate = createSolidColorPng(50, 70, [255, 255, 255, 255]);

      const result = await engine.compareBuffers(baseline, candidate, {
        diffThreshold: 0.01,
      });

      // Padded to 50x70 = 3500 pixels. Extra 50x20 = 1000 pixels difference.
      expect(result.dimensions.diff.width).toBe(50);
      expect(result.dimensions.diff.height).toBe(70);
      expect(result.totalPixels).toBe(3500);
      expect(result.passed).toBe(false);
      expect(result.mismatchPixels).toBeGreaterThan(0);
    });

    it('writes diff image file to disk when outputDiffPath is provided', async () => {
      const baseline = createSolidColorPng(40, 40, [255, 255, 255, 255]);
      const candidate = createSolidColorPng(40, 40, [0, 0, 0, 255]);
      const diffOutPath = path.join(tempDir, 'diffs', 'output-diff.png');

      const result = await engine.compareBuffers(baseline, candidate, {
        outputDiffPath: diffOutPath,
      });

      expect(fs.existsSync(diffOutPath)).toBe(true);
      expect(result.diffImagePath).toBe(diffOutPath);

      const savedDiffPng = loadPng(diffOutPath);
      expect(savedDiffPng.width).toBe(40);
      expect(savedDiffPng.height).toBe(40);
    });
  });
});
