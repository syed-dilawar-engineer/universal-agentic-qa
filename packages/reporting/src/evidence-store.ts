import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  EvidenceArtifact,
  EvidenceArtifactSchema,
  EvidenceType,
  EvidenceTypeSchema,
} from '@agentic-qa/schemas';
import {
  EvidenceStoreOptions,
  StoreArtifactOptions,
  ArtifactIntegrityResult,
  ArtifactQueryFilter,
} from './types.js';
import { redactSecrets } from '@agentic-qa/core';

export function computeSha256(data: Buffer | Uint8Array | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function inferMimeType(type: EvidenceType): string {
  switch (type) {
    case 'SCREENSHOT':
    case 'PERCEPTUAL_DIFF':
      return 'image/png';
    case 'DOM_SNAPSHOT':
      return 'text/html';
    case 'CONSOLE_LOG':
    case 'SYSTEM_LOG':
      return 'text/plain';
    case 'NETWORK_HAR':
    case 'AXE_A11Y_REPORT':
    case 'PERF_METRICS':
      return 'application/json';
    case 'TRACE':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

export function inferExtension(type: EvidenceType, mimeType?: string): string {
  if (mimeType) {
    if (mimeType.includes('png')) return 'png';
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
    if (mimeType.includes('html')) return 'html';
    if (mimeType.includes('json')) return 'json';
    if (mimeType.includes('zip')) return 'zip';
    if (mimeType.includes('plain')) return 'log';
  }
  switch (type) {
    case 'SCREENSHOT':
    case 'PERCEPTUAL_DIFF':
      return 'png';
    case 'DOM_SNAPSHOT':
      return 'html';
    case 'CONSOLE_LOG':
    case 'SYSTEM_LOG':
      return 'log';
    case 'NETWORK_HAR':
      return 'har';
    case 'AXE_A11Y_REPORT':
    case 'PERF_METRICS':
      return 'json';
    case 'TRACE':
      return 'zip';
    default:
      return 'bin';
  }
}

export class EvidenceStore {
  readonly baseDir: string;
  readonly autoPersistIndex: boolean;
  readonly indexFileName: string;
  private readonly index: Map<string, EvidenceArtifact> = new Map();
  private initialized = false;

  constructor(options: EvidenceStoreOptions = {}) {
    this.baseDir = path.resolve(options.baseDir || '.qa-output/evidence');
    this.autoPersistIndex = options.autoPersistIndex ?? true;
    this.indexFileName = options.indexFileName || 'evidence-index.json';
  }

  /**
   * Ensure storage directory exists
   */
  async init(): Promise<void> {
    if (!this.initialized) {
      await fs.mkdir(this.baseDir, { recursive: true });
      this.initialized = true;
    }
  }

  /**
   * Stores an evidence artifact on disk with SHA-256 integrity hash and indexes it
   */
  async storeArtifact(options: StoreArtifactOptions): Promise<EvidenceArtifact> {
    await this.init();

    // Validate type
    EvidenceTypeSchema.parse(options.type);

    const id = options.id || `ev-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const buffer = typeof options.content === 'string'
      ? Buffer.from(options.content, 'utf-8')
      : Buffer.from(options.content);

    const sha256 = computeSha256(buffer);
    const mimeType = options.mimeType || inferMimeType(options.type);
    const ext = inferExtension(options.type, mimeType);
    const safeFilename = options.filename
      ? path.basename(options.filename)
      : `${id}.${ext}`;

    const filePath = path.join(this.baseDir, safeFilename);
    await fs.writeFile(filePath, buffer);

    const artifact: EvidenceArtifact = {
      id,
      type: options.type,
      path: filePath,
      sha256,
      sizeBytes: buffer.length,
      mimeType,
      capturedAt: options.capturedAt || new Date().toISOString(),
      description: options.description || '',
      metadata: options.metadata || {},
    };

    // Validate against schema
    const validated = EvidenceArtifactSchema.parse(artifact);
    this.index.set(id, validated);

    if (this.autoPersistIndex) {
      await this.persistIndex();
    }

    return validated;
  }

  /**
   * Convenience helper to store a screenshot
   */
  async storeScreenshot(
    content: Buffer | Uint8Array | string,
    description: string = 'Screenshot capture',
    metadata: Record<string, any> = {}
  ): Promise<EvidenceArtifact> {
    return this.storeArtifact({
      type: 'SCREENSHOT',
      content,
      description,
      metadata,
    });
  }

  /**
   * Convenience helper to store a text log (console or system)
   */
  async storeLog(
    type: 'CONSOLE_LOG' | 'SYSTEM_LOG',
    content: string,
    description: string = `${type} output`,
    metadata: Record<string, any> = {}
  ): Promise<EvidenceArtifact> {
    return this.storeArtifact({
      type,
      content: redactSecrets(content),
      description,
      metadata,
    });
  }

  /**
   * Convenience helper to store a perceptual diff image
   */
  async storeDiff(
    content: Buffer | Uint8Array | string,
    description: string = 'Visual perceptual diff',
    metadata: Record<string, any> = {}
  ): Promise<EvidenceArtifact> {
    return this.storeArtifact({
      type: 'PERCEPTUAL_DIFF',
      content,
      description,
      metadata,
    });
  }

  /**
   * Convenience helper to store a DOM snapshot
   */
  async storeDomSnapshot(
    content: string,
    description: string = 'DOM state snapshot',
    metadata: Record<string, any> = {}
  ): Promise<EvidenceArtifact> {
    return this.storeArtifact({
      type: 'DOM_SNAPSHOT',
      content: redactSecrets(content),
      mimeType: 'text/html',
      description,
      metadata,
    });
  }

  /**
   * Convenience helper to store a trace or profile
   */
  async storeTrace(
    content: Buffer | Uint8Array | string,
    description: string = 'Execution trace',
    metadata: Record<string, any> = {}
  ): Promise<EvidenceArtifact> {
    return this.storeArtifact({
      type: 'TRACE',
      content,
      description,
      metadata,
    });
  }

  /**
   * Copies an existing file from disk into the evidence store with SHA-256 computation
   */
  async storeFile(
    sourceFilePath: string,
    type: EvidenceType,
    description?: string,
    metadata: Record<string, any> = {}
  ): Promise<EvidenceArtifact> {
    await this.init();
    const content = await fs.readFile(sourceFilePath);
    const originalExt = path.extname(sourceFilePath).replace(/^\./, '');
    const filename = `${path.basename(sourceFilePath, path.extname(sourceFilePath))}-${Date.now()}.${originalExt || inferExtension(type)}`;

    return this.storeArtifact({
      type,
      content,
      filename,
      description: description || `Imported file: ${path.basename(sourceFilePath)}`,
      metadata: {
        ...metadata,
        originalSourcePath: sourceFilePath,
      },
    });
  }

  /**
   * Registers a pre-constructed artifact into the index
   */
  registerArtifact(artifact: EvidenceArtifact): void {
    const validated = EvidenceArtifactSchema.parse(artifact);
    this.index.set(validated.id, validated);
  }

  /**
   * Retrieve artifact metadata by ID
   */
  getArtifact(id: string): EvidenceArtifact | undefined {
    return this.index.get(id);
  }

  /**
   * Retrieve raw content buffer of an artifact
   */
  async getArtifactBuffer(id: string): Promise<Buffer> {
    const artifact = this.getArtifact(id);
    if (!artifact) {
      throw new Error(`Evidence artifact '${id}' not found in store.`);
    }
    const resolvedPath = path.isAbsolute(artifact.path)
      ? artifact.path
      : path.resolve(this.baseDir, artifact.path);
    return fs.readFile(resolvedPath);
  }

  /**
   * Retrieve text content of an artifact
   */
  async getArtifactText(id: string): Promise<string> {
    const buffer = await this.getArtifactBuffer(id);
    return buffer.toString('utf-8');
  }

  /**
   * Check if artifact exists in index
   */
  hasArtifact(id: string): boolean {
    return this.index.has(id);
  }

  /**
   * Total count of indexed artifacts
   */
  count(): number {
    return this.index.size;
  }

  /**
   * List all artifacts matching an optional filter
   */
  listArtifacts(filter?: ArtifactQueryFilter): EvidenceArtifact[] {
    const artifacts = Array.from(this.index.values());
    if (!filter) {
      return artifacts;
    }

    return artifacts.filter((art) => {
      if (filter.type && art.type !== filter.type) return false;
      if (filter.mimeType && !art.mimeType.toLowerCase().includes(filter.mimeType.toLowerCase())) return false;
      if (filter.testCaseId && art.metadata?.testCaseId !== filter.testCaseId) return false;
      if (filter.stepId && art.metadata?.stepId !== filter.stepId) return false;
      if (filter.tag && !art.metadata?.tags?.includes?.(filter.tag)) return false;

      if (filter.since) {
        const sinceTime = new Date(filter.since).getTime();
        const artTime = new Date(art.capturedAt).getTime();
        if (artTime < sinceTime) return false;
      }

      if (filter.until) {
        const untilTime = new Date(filter.until).getTime();
        const artTime = new Date(art.capturedAt).getTime();
        if (artTime > untilTime) return false;
      }

      return true;
    });
  }

  /**
   * Get all artifacts associated with a specific test case ID
   */
  getArtifactsForTest(testCaseId: string): EvidenceArtifact[] {
    return this.listArtifacts({ testCaseId });
  }

  /**
   * Return an array of all indexed artifacts
   */
  getAllArtifacts(): EvidenceArtifact[] {
    return Array.from(this.index.values());
  }

  /**
   * Verify SHA-256 integrity of a single stored artifact against its file on disk
   */
  async verifyIntegrity(id: string): Promise<ArtifactIntegrityResult> {
    const artifact = this.getArtifact(id);
    if (!artifact) {
      return {
        id,
        valid: false,
        expectedSha256: '',
        path: '',
        error: `Artifact '${id}' not found in store index.`,
      };
    }

    const resolvedPath = path.isAbsolute(artifact.path)
      ? artifact.path
      : path.resolve(this.baseDir, artifact.path);

    try {
      const fileBuffer = await fs.readFile(resolvedPath);
      const actualSha256 = computeSha256(fileBuffer);
      const valid = actualSha256 === artifact.sha256;

      return {
        id,
        valid,
        expectedSha256: artifact.sha256,
        actualSha256,
        path: resolvedPath,
        error: valid ? undefined : `Hash mismatch! Expected ${artifact.sha256}, got ${actualSha256}. Evidence may have been tampered with.`,
      };
    } catch (err: any) {
      return {
        id,
        valid: false,
        expectedSha256: artifact.sha256,
        path: resolvedPath,
        error: `Could not read artifact file from disk: ${err.message}`,
      };
    }
  }

  /**
   * Verify SHA-256 integrity for all indexed artifacts
   */
  async verifyAllIntegrity(): Promise<{
    valid: boolean;
    results: Record<string, ArtifactIntegrityResult>;
    tamperedCount: number;
    totalCount: number;
  }> {
    const results: Record<string, ArtifactIntegrityResult> = {};
    let tamperedCount = 0;

    for (const id of this.index.keys()) {
      const res = await this.verifyIntegrity(id);
      results[id] = res;
      if (!res.valid) {
        tamperedCount++;
      }
    }

    return {
      valid: tamperedCount === 0,
      results,
      tamperedCount,
      totalCount: this.index.size,
    };
  }

  /**
   * Persists the current in-memory index to JSON on disk
   */
  async persistIndex(): Promise<string> {
    await this.init();
    const indexPath = path.join(this.baseDir, this.indexFileName);
    const data = JSON.stringify(Array.from(this.index.values()), null, 2);
    await fs.writeFile(indexPath, data, 'utf-8');
    return indexPath;
  }

  /**
   * Loads indexed artifacts from JSON on disk
   */
  async loadIndex(): Promise<number> {
    const indexPath = path.join(this.baseDir, this.indexFileName);
    try {
      const raw = await fs.readFile(indexPath, 'utf-8');
      const items = JSON.parse(raw);
      if (Array.isArray(items)) {
        for (const item of items) {
          const validated = EvidenceArtifactSchema.parse(item);
          this.index.set(validated.id, validated);
        }
      }
      return this.index.size;
    } catch {
      return 0;
    }
  }

  /**
   * Clears in-memory index
   */
  async clear(): Promise<void> {
    this.index.clear();
  }
}
