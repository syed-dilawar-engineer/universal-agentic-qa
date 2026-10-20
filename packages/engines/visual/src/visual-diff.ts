import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Finding, EvidenceArtifact, Platform } from '@agentic-qa/schemas';
import type {
  VisualDiffOptions,
  VisualDiffResult,
  MaskRegion,
} from './types.js';
import {
  loadPng,
  writePngBuffer,
  writePngFile,
  computeSha256,
  normalizeImageDimensions,
  applyRegionMasks,
  overlayMaskRegionsOnDiff,
} from './utils/image.js';

export class VisualDiffEngine {
  private defaultDiffThreshold: number;
  private defaultPerceptualThreshold: number;
  private defaultIncludeAA: boolean;

  constructor(options: {
    defaultDiffThreshold?: number;
    defaultPerceptualThreshold?: number;
    defaultIncludeAA?: boolean;
  } = {}) {
    // 0.01 = 1% mismatch tolerance by default
    this.defaultDiffThreshold = options.defaultDiffThreshold ?? 0.01;
    this.defaultPerceptualThreshold = options.defaultPerceptualThreshold ?? 0.1;
    this.defaultIncludeAA = options.defaultIncludeAA ?? true;
  }

  /**
   * Compares a baseline screenshot and candidate screenshot from file paths.
   *
   * Critical guarantees:
   * - Never auto-approve new baselines without explicit `updateBaselines: true`
   * - Never mark as PASSED if baseline or candidate image is missing.
   */
  async compareFiles(
    baselinePath: string,
    candidatePath: string,
    options: VisualDiffOptions = {}
  ): Promise<VisualDiffResult> {
    const candidateExists = fs.existsSync(candidatePath);
    const baselineExists = fs.existsSync(baselinePath);

    // Rule: Never mark as PASSED if candidate image is missing
    if (!candidateExists) {
      return this.createErrorResult({
        baselinePath,
        candidatePath,
        error: `Candidate image does not exist: "${candidatePath}"`,
        options,
      });
    }

    // Rule: Never auto-approve new baselines without explicit flag
    if (!baselineExists) {
      if (options.updateBaselines) {
        // User explicitly instructed to update/create baselines (--update-baselines)
        const candidateBuf = fs.readFileSync(candidatePath);
        const baselineDir = path.dirname(baselinePath);
        if (!fs.existsSync(baselineDir)) {
          fs.mkdirSync(baselineDir, { recursive: true });
        }
        fs.writeFileSync(baselinePath, candidateBuf);

        const candidatePng = loadPng(candidateBuf);
        return {
          passed: true,
          mismatchPercentage: 0,
          mismatchRatio: 0,
          mismatchPixels: 0,
          totalPixels: candidatePng.width * candidatePng.height,
          diffThreshold: options.diffThreshold ?? this.defaultDiffThreshold,
          baselinePath,
          candidatePath,
          baselineCreated: true,
          maskedRegions: options.masks ?? [],
          dimensions: {
            baseline: { width: candidatePng.width, height: candidatePng.height },
            candidate: { width: candidatePng.width, height: candidatePng.height },
            diff: { width: candidatePng.width, height: candidatePng.height },
          },
        };
      }

      // Explicit flag not provided: Fail deterministically
      return this.createErrorResult({
        baselinePath,
        candidatePath,
        error: `Baseline image does not exist: "${baselinePath}". Run with updateBaselines: true (--update-baselines) to establish an initial baseline.`,
        options,
      });
    }

    // If updateBaselines is true and baseline exists, but user wants to update baseline with candidate
    if (options.updateBaselines) {
      const candidateBuf = fs.readFileSync(candidatePath);
      fs.writeFileSync(baselinePath, candidateBuf);
      const candidatePng = loadPng(candidateBuf);
      return {
        passed: true,
        mismatchPercentage: 0,
        mismatchRatio: 0,
        mismatchPixels: 0,
        totalPixels: candidatePng.width * candidatePng.height,
        diffThreshold: options.diffThreshold ?? this.defaultDiffThreshold,
        baselinePath,
        candidatePath,
        baselineCreated: true,
        maskedRegions: options.masks ?? [],
        dimensions: {
          baseline: { width: candidatePng.width, height: candidatePng.height },
          candidate: { width: candidatePng.width, height: candidatePng.height },
          diff: { width: candidatePng.width, height: candidatePng.height },
        },
      };
    }

    const baselineBuffer = fs.readFileSync(baselinePath);
    const candidateBuffer = fs.readFileSync(candidatePath);

    const result = await this.compareBuffers(baselineBuffer, candidateBuffer, {
      ...options,
      baselinePath,
      candidatePath,
    });

    return result;
  }

  /**
   * Compares two PNG image buffers with perceptual diffing and dynamic region masking.
   */
  async compareBuffers(
    baselineBuffer: Buffer,
    candidateBuffer: Buffer,
    options: VisualDiffOptions & {
      baselinePath?: string;
      candidatePath?: string;
    } = {}
  ): Promise<VisualDiffResult> {
    // Rule: Never mark as PASSED if baseline or candidate image is missing
    if (!baselineBuffer || baselineBuffer.length === 0) {
      return this.createErrorResult({
        baselinePath: options.baselinePath,
        candidatePath: options.candidatePath,
        error: 'Baseline image buffer is empty or missing.',
        options,
      });
    }

    if (!candidateBuffer || candidateBuffer.length === 0) {
      return this.createErrorResult({
        baselinePath: options.baselinePath,
        candidatePath: options.candidatePath,
        error: 'Candidate image buffer is empty or missing.',
        options,
      });
    }

    let baselinePng: PNG;
    let candidatePng: PNG;

    try {
      baselinePng = loadPng(baselineBuffer);
    } catch (err: any) {
      return this.createErrorResult({
        baselinePath: options.baselinePath,
        candidatePath: options.candidatePath,
        error: `Failed to decode baseline PNG: ${err.message}`,
        options,
      });
    }

    try {
      candidatePng = loadPng(candidateBuffer);
    } catch (err: any) {
      return this.createErrorResult({
        baselinePath: options.baselinePath,
        candidatePath: options.candidatePath,
        error: `Failed to decode candidate PNG: ${err.message}`,
        options,
      });
    }

    const origBaselineDimensions = {
      width: baselinePng.width,
      height: baselinePng.height,
    };
    const origCandidateDimensions = {
      width: candidatePng.width,
      height: candidatePng.height,
    };

    // Handle dimension mismatch gracefully by padding smaller image
    const {
      normalized1,
      normalized2,
      width,
      height,
    } = normalizeImageDimensions(baselinePng, candidatePng);

    const totalPixels = width * height;
    const masks = options.masks ?? [];

    // Apply dynamic region masking (exclude timestamps, animated banners, avatars, etc.)
    if (masks.length > 0) {
      applyRegionMasks(normalized1, normalized2, masks, width, height);
    }

    // Allocate diff canvas
    const diffPng = new PNG({ width, height });

    const diffThreshold = options.diffThreshold ?? this.defaultDiffThreshold;
    const perceptualThreshold =
      options.perceptualThreshold ?? this.defaultPerceptualThreshold;
    const includeAA = options.includeAA ?? this.defaultIncludeAA;
    const diffColor: [number, number, number] = options.diffColor ?? [255, 0, 0];

    // Execute pixelmatch perceptual diff
    const mismatchPixels = pixelmatch(
      normalized1.data,
      normalized2.data,
      diffPng.data,
      width,
      height,
      {
        threshold: perceptualThreshold,
        diffColor,
        includeAA,
      }
    );

    // Overlay visual indication for masked regions on the diff image
    if (masks.length > 0) {
      overlayMaskRegionsOnDiff(diffPng, masks, width, height);
    }

    const mismatchRatio = totalPixels > 0 ? mismatchPixels / totalPixels : 0;
    const mismatchPercentage = mismatchRatio * 100;
    const passed = mismatchRatio <= diffThreshold;

    const diffImageBuffer = writePngBuffer(diffPng);

    let diffImagePath: string | undefined;
    if (options.outputDiffPath) {
      writePngFile(options.outputDiffPath, diffPng);
      diffImagePath = options.outputDiffPath;
    }

    const dimensions = {
      baseline: origBaselineDimensions,
      candidate: origCandidateDimensions,
      diff: { width, height },
    };

    const result: VisualDiffResult = {
      passed,
      mismatchPercentage,
      mismatchRatio,
      mismatchPixels,
      totalPixels,
      diffThreshold,
      diffImagePath,
      diffImageBuffer,
      baselinePath: options.baselinePath,
      candidatePath: options.candidatePath,
      baselineCreated: false,
      maskedRegions: masks,
      dimensions,
    };

    // If diff failed, create structured Finding and EvidenceArtifact
    if (!passed) {
      result.evidenceArtifact = this.createEvidenceArtifact(
        diffImageBuffer,
        diffImagePath,
        mismatchPercentage,
        mismatchPixels,
        totalPixels,
        diffThreshold
      );

      result.finding = this.createFinding(
        result,
        options.platform ?? 'web',
        options.testCaseId
      );
    }

    return result;
  }

  /**
   * Helper to create dynamic mask regions for timestamps, animated banners, avatars.
   */
  createMask(
    x: number,
    y: number,
    width: number,
    height: number,
    name?: string,
    category: MaskRegion['category'] = 'custom'
  ): MaskRegion {
    return { x, y, width, height, name, category };
  }

  createTimestampMask(
    x: number,
    y: number,
    width: number,
    height: number,
    name: string = 'timestamp'
  ): MaskRegion {
    return this.createMask(x, y, width, height, name, 'timestamp');
  }

  createBannerMask(
    x: number,
    y: number,
    width: number,
    height: number,
    name: string = 'animated-banner'
  ): MaskRegion {
    return this.createMask(x, y, width, height, name, 'banner');
  }

  createAvatarMask(
    x: number,
    y: number,
    width: number,
    height: number,
    name: string = 'user-avatar'
  ): MaskRegion {
    return this.createMask(x, y, width, height, name, 'avatar');
  }

  private createErrorResult(params: {
    baselinePath?: string;
    candidatePath?: string;
    error: string;
    options: VisualDiffOptions;
  }): VisualDiffResult {
    const result: VisualDiffResult = {
      passed: false,
      mismatchPercentage: 100,
      mismatchRatio: 1.0,
      mismatchPixels: 0,
      totalPixels: 0,
      diffThreshold: params.options.diffThreshold ?? this.defaultDiffThreshold,
      baselinePath: params.baselinePath,
      candidatePath: params.candidatePath,
      baselineCreated: false,
      maskedRegions: params.options.masks ?? [],
      dimensions: {
        diff: { width: 0, height: 0 },
      },
      error: params.error,
    };

    result.finding = {
      id: `FIND-VISUAL-ERR-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      title: `Visual Regression Check Failed: ${params.error}`,
      description: params.error,
      severity: 'HIGH',
      status: 'CONFIRMED',
      fixVerification: 'UNVERIFIED',
      platform: params.options.platform ?? 'web',
      testCaseId: params.options.testCaseId,
      preconditions: [
        params.baselinePath ? `Baseline path: ${params.baselinePath}` : 'Baseline specified',
        params.candidatePath ? `Candidate path: ${params.candidatePath}` : 'Candidate specified',
      ],
      reproductionSteps: [
        `1. Run visual regression check between baseline and candidate`,
        `2. Observe missing image or initialization failure: ${params.error}`,
      ],
      expectedBehavior: 'Both baseline and candidate images must exist and be valid PNG files',
      actualBehavior: params.error,
      evidenceIds: [],
      reproducibilityCount: 1,
      reproducibilitySuccessRate: 1.0,
      detectedAt: new Date().toISOString(),
      metadata: {
        baselinePath: params.baselinePath,
        candidatePath: params.candidatePath,
      },
    };

    return result;
  }

  private createEvidenceArtifact(
    buffer: Buffer,
    filePath: string | undefined,
    mismatchPercentage: number,
    mismatchPixels: number,
    totalPixels: number,
    threshold: number
  ): EvidenceArtifact {
    const sha256 = computeSha256(buffer);
    return {
      id: `EV-DIFF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: 'PERCEPTUAL_DIFF',
      path: filePath ?? `inline://diff-${sha256.slice(0, 8)}.png`,
      sha256,
      sizeBytes: buffer.length,
      mimeType: 'image/png',
      capturedAt: new Date().toISOString(),
      description: `Perceptual visual diff highlighting mismatched pixels in red (${mismatchPercentage.toFixed(2)}% difference)`,
      metadata: {
        mismatchPixels,
        totalPixels,
        mismatchPercentage,
        threshold,
      },
    };
  }

  private createFinding(
    result: VisualDiffResult,
    platform: Platform,
    testCaseId?: string
  ): Finding {
    const thresholdPct = (result.diffThreshold * 100).toFixed(2);
    const observedPct = result.mismatchPercentage.toFixed(2);
    const severity = result.mismatchPercentage > 5.0 ? 'HIGH' : 'MEDIUM';

    const evidenceIds: string[] = [];
    if (result.evidenceArtifact) {
      evidenceIds.push(result.evidenceArtifact.id);
    }

    return {
      id: `FIND-VISUAL-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      title: `Visual Regression: ${observedPct}% pixel mismatch exceeds ${thresholdPct}% threshold`,
      description: `Perceptual diff detected ${result.mismatchPixels} mismatched pixels out of ${result.totalPixels} (${observedPct}%). This exceeds the allowed tolerance threshold of ${thresholdPct}%.`,
      severity,
      status: 'CONFIRMED',
      fixVerification: 'UNVERIFIED',
      platform,
      testCaseId,
      preconditions: [
        result.baselinePath ? `Baseline: ${result.baselinePath}` : 'Baseline screenshot exists',
        result.candidatePath ? `Candidate: ${result.candidatePath}` : 'Candidate screenshot captured',
      ],
      reproductionSteps: [
        '1. Capture candidate screenshot for target viewport',
        '2. Run VisualDiffEngine comparison against baseline screenshot',
        '3. Inspect perceptual diff image highlighting pixel differences in red',
      ],
      expectedBehavior: `Visual mismatch must not exceed ${thresholdPct}% of total canvas`,
      actualBehavior: `Observed ${observedPct}% mismatched pixels (${result.mismatchPixels} differing pixels)`,
      evidenceIds,
      reproducibilityCount: 1,
      reproducibilitySuccessRate: 1.0,
      detectedAt: new Date().toISOString(),
      metadata: {
        mismatchPixels: result.mismatchPixels,
        totalPixels: result.totalPixels,
        mismatchPercentage: result.mismatchPercentage,
        diffThreshold: result.diffThreshold,
        maskedRegionsCount: result.maskedRegions.length,
        dimensions: result.dimensions,
      },
    };
  }
}
