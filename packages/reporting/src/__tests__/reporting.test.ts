import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  EvidenceStore,
  computeSha256,
  inferMimeType,
  inferExtension,
} from '../evidence-store.js';
import { TrustScorer } from '../trust-scorer.js';
import { ReportFormatter } from '../report-formatter.js';
import {
  QARunReport,
  QARunReportSchema,
  TestPlan,
  TestCaseResult,
  Finding,
  EvidenceArtifact,
} from '@agentic-qa/schemas';

describe('EvidenceStore', () => {
  let tempDir: string;
  let store: EvidenceStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-store-test-'));
    store = new EvidenceStore({ baseDir: tempDir, autoPersistIndex: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('stores screenshot buffer and calculates correct SHA-256 hash', async () => {
    const rawData = Buffer.from('fake-png-image-binary-data');
    const expectedHash = computeSha256(rawData);

    const artifact = await store.storeScreenshot(rawData, 'Login screen capture', {
      testCaseId: 'TC-101',
      viewport: 'desktop',
    });

    expect(artifact.id).toMatch(/^ev-/);
    expect(artifact.type).toBe('SCREENSHOT');
    expect(artifact.mimeType).toBe('image/png');
    expect(artifact.sha256).toBe(expectedHash);
    expect(artifact.sizeBytes).toBe(rawData.length);
    expect(artifact.metadata.testCaseId).toBe('TC-101');

    // Verify stored file on disk
    const storedBuffer = await store.getArtifactBuffer(artifact.id);
    expect(storedBuffer.equals(rawData)).toBe(true);

    const integrity = await store.verifyIntegrity(artifact.id);
    expect(integrity.valid).toBe(true);
    expect(integrity.actualSha256).toBe(expectedHash);
  });

  it('stores text logs (CONSOLE_LOG and SYSTEM_LOG)', async () => {
    const logContent = 'Error: Uncaught TypeError in bundle.js:42\n  at login (app.js:10)';
    const art = await store.storeLog('CONSOLE_LOG', logContent, 'Browser console error', {
      testCaseId: 'TC-102',
    });

    expect(art.type).toBe('CONSOLE_LOG');
    expect(art.mimeType).toBe('text/plain');
    expect(await store.getArtifactText(art.id)).toBe(logContent);
  });

  it('stores perceptual diff and dom snapshot', async () => {
    const diffArt = await store.storeDiff(Buffer.from('diff-bytes'), 'Button mismatch diff');
    expect(diffArt.type).toBe('PERCEPTUAL_DIFF');

    const domArt = await store.storeDomSnapshot('<html><body><h1>Test</h1></body></html>');
    expect(domArt.type).toBe('DOM_SNAPSHOT');
    expect(domArt.mimeType).toBe('text/html');
  });

  it('stores existing file from disk via storeFile', async () => {
    const srcFile = path.join(tempDir, 'source.txt');
    await fs.writeFile(srcFile, 'source file content', 'utf-8');

    const art = await store.storeFile(srcFile, 'SYSTEM_LOG', 'System crash trace');
    expect(art.type).toBe('SYSTEM_LOG');
    expect(art.metadata.originalSourcePath).toBe(srcFile);
    expect(await store.getArtifactText(art.id)).toBe('source file content');
  });

  it('detects tampering when an evidence file on disk is modified', async () => {
    const raw = Buffer.from('legitimate-evidence-bytes');
    const art = await store.storeScreenshot(raw, 'Audit capture');

    // Check clean integrity first
    let integrity = await store.verifyIntegrity(art.id);
    expect(integrity.valid).toBe(true);

    // Tamper with file on disk
    await fs.writeFile(art.path, Buffer.from('tampered-malicious-content'));

    // Check integrity again: should detect mismatch
    integrity = await store.verifyIntegrity(art.id);
    expect(integrity.valid).toBe(false);
    expect(integrity.error).toContain('Hash mismatch');
    expect(integrity.actualSha256).not.toBe(art.sha256);

    const allIntegrity = await store.verifyAllIntegrity();
    expect(allIntegrity.valid).toBe(false);
    expect(allIntegrity.tamperedCount).toBe(1);
  });

  it('handles missing artifact file during integrity check', async () => {
    const art = await store.storeScreenshot(Buffer.from('temp-data'), 'Temporary');
    await fs.unlink(art.path);

    const integrity = await store.verifyIntegrity(art.id);
    expect(integrity.valid).toBe(false);
    expect(integrity.error).toContain('Could not read artifact file');
  });

  it('queries artifacts by type and metadata filter', async () => {
    await store.storeScreenshot(Buffer.from('img1'), 'Img 1', { testCaseId: 'TC-A', tags: ['ui'] });
    await store.storeScreenshot(Buffer.from('img2'), 'Img 2', { testCaseId: 'TC-B', tags: ['ui'] });
    await store.storeLog('CONSOLE_LOG', 'log1', 'Log 1', { testCaseId: 'TC-A' });

    expect(store.listArtifacts({ type: 'SCREENSHOT' })).toHaveLength(2);
    expect(store.listArtifacts({ type: 'CONSOLE_LOG' })).toHaveLength(1);
    expect(store.listArtifacts({ testCaseId: 'TC-A' })).toHaveLength(2);
    expect(store.listArtifacts({ tag: 'ui' })).toHaveLength(2);
    expect(store.getArtifactsForTest('TC-B')).toHaveLength(1);
  });

  it('persists index to disk and recovers index on new store instance', async () => {
    await store.storeScreenshot(Buffer.from('p1'), 'P1');
    await store.storeLog('SYSTEM_LOG', 'sys log', 'SysLog');

    const newStore = new EvidenceStore({ baseDir: tempDir });
    expect(newStore.count()).toBe(0);

    const loadedCount = await newStore.loadIndex();
    expect(loadedCount).toBe(2);
    expect(newStore.count()).toBe(2);
  });

  it('handles empty buffer/zero-byte evidence artifact', async () => {
    const empty = Buffer.alloc(0);
    const art = await store.storeArtifact({
      type: 'TRACE',
      content: empty,
      description: 'Zero byte trace',
    });

    expect(art.sizeBytes).toBe(0);
    expect(art.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const integrity = await store.verifyIntegrity(art.id);
    expect(integrity.valid).toBe(true);
  });

  it('sanitizes filename to prevent path traversal', async () => {
    const art = await store.storeArtifact({
      type: 'SYSTEM_LOG',
      content: 'log data',
      filename: '../../traversal.log',
    });

    expect(path.dirname(art.path)).toBe(store.baseDir);
    expect(path.basename(art.path)).toBe('traversal.log');
  });

  it('filters artifacts by date range', async () => {
    const past = new Date(Date.now() - 100000).toISOString();
    const future = new Date(Date.now() + 100000).toISOString();

    await store.storeLog('CONSOLE_LOG', 'past log', 'past', { capturedAt: past });
    await store.storeLog('CONSOLE_LOG', 'future log', 'future', { capturedAt: future });

    const recent = store.listArtifacts({ since: new Date(Date.now() - 50000) });
    expect(recent.length).toBeGreaterThanOrEqual(1);
  });

  it('throws when getting buffer for non-existent artifact', async () => {
    await expect(store.getArtifactBuffer('non-existent')).rejects.toThrow('not found');
  });

  it('handles corrupted index file gracefully', async () => {
    const indexPath = path.join(tempDir, 'evidence-index.json');
    await fs.writeFile(indexPath, '{ corrupted json', 'utf-8');

    const loaded = await store.loadIndex();
    expect(loaded).toBe(0);
  });

  it('clears in-memory index', async () => {
    await store.storeScreenshot(Buffer.from('test'));
    expect(store.count()).toBe(1);
    await store.clear();
    expect(store.count()).toBe(0);
  });
});

describe('TrustScorer', () => {
  it('calculates high trust score for clean run with deterministic assertions and evidence', () => {
    const testResults: TestCaseResult[] = [
      {
        testCaseId: 'TC-01',
        title: 'User Login',
        status: 'PASSED',
        durationMs: 320,
        attemptCount: 1,
        evidenceIds: ['ev-1', 'ev-2'],
        stepResults: [
          {
            stepId: 'step-1',
            status: 'PASSED',
            durationMs: 150,
            evidenceIds: ['ev-1'],
          },
          {
            stepId: 'step-2',
            status: 'PASSED',
            durationMs: 170,
            evidenceIds: ['ev-2'],
          },
        ],
      },
      {
        testCaseId: 'TC-02',
        title: 'Checkout Cart',
        status: 'PASSED',
        durationMs: 400,
        attemptCount: 1,
        evidenceIds: ['ev-3'],
        stepResults: [
          {
            stepId: 'step-1',
            status: 'PASSED',
            durationMs: 200,
            evidenceIds: ['ev-3'],
          },
          {
            stepId: 'step-2',
            status: 'PASSED',
            durationMs: 200,
            evidenceIds: [],
          },
        ],
      },
    ];

    const evidence: EvidenceArtifact[] = [
      {
        id: 'ev-1',
        type: 'SCREENSHOT',
        path: '/tmp/ev1.png',
        sha256: 'a'.repeat(64),
        sizeBytes: 1024,
        mimeType: 'image/png',
        capturedAt: new Date().toISOString(),
        description: 'Login screen',
        metadata: {},
      },
      {
        id: 'ev-2',
        type: 'CONSOLE_LOG',
        path: '/tmp/ev2.log',
        sha256: 'b'.repeat(64),
        sizeBytes: 512,
        mimeType: 'text/plain',
        capturedAt: new Date().toISOString(),
        description: 'Console log',
        metadata: {},
      },
      {
        id: 'ev-3',
        type: 'SCREENSHOT',
        path: '/tmp/ev3.png',
        sha256: 'c'.repeat(64),
        sizeBytes: 2048,
        mimeType: 'image/png',
        capturedAt: new Date().toISOString(),
        description: 'Cart screen',
        metadata: {},
      },
    ];

    const plan: TestPlan = {
      planId: 'plan-01',
      name: 'Smoke Plan',
      targetApp: 'https://example.com',
      platform: 'web',
      environment: 'staging',
      createdAt: new Date().toISOString(),
      metadata: {},
      scenarios: [
        {
          id: 'TC-01',
          title: 'User Login',
          description: 'Login',
          platform: 'web',
          timeoutMs: 5000,
          retries: 0,
          tags: ['smoke'],
          expectedOutcome: 'PASS',
          steps: [
            {
              id: 'step-1',
              description: 'Fill credentials',
              continueOnFailure: false,
              action: { type: 'fill', target: '#user', value: 'admin', timeoutMs: 1000, metadata: {} },
            },
            {
              id: 'step-2',
              description: 'Verify login header',
              continueOnFailure: false,
              assertion: { type: 'elementTextEquals', expected: 'Welcome', critical: true, metadata: {} },
            },
          ],
        },
        {
          id: 'TC-02',
          title: 'Checkout Cart',
          description: 'Checkout',
          platform: 'web',
          timeoutMs: 5000,
          retries: 0,
          tags: ['smoke'],
          expectedOutcome: 'PASS',
          steps: [
            {
              id: 'step-1',
              description: 'Verify status 200',
              continueOnFailure: false,
              assertion: { type: 'status200', critical: true, metadata: {} },
            },
            {
              id: 'step-2',
              description: 'Verify total',
              continueOnFailure: false,
              assertion: { type: 'elementVisible', expected: true, critical: true, metadata: {} },
            },
          ],
        },
      ],
    };

    const scorer = new TrustScorer();
    const result = scorer.calculate({
      testResults,
      evidence,
      testPlan: plan,
    });

    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.deterministicAssertionsCount).toBe(3);
    expect(result.evidenceArtifactsCount).toBe(3);
    expect(result.reproducibilityScore).toBe(100);
    expect(result.coverageScore).toBe(100);
    expect(result.honestyPenalty).toBe(0);
    expect(result.summary).toContain('High Trust');
  });

  it('applies honesty penalty when unverified assertions or missing baselines are present', () => {
    const scorer = new TrustScorer();

    const testResults: TestCaseResult[] = [
      {
        testCaseId: 'TC-EMPTY',
        title: 'Empty Test claiming pass',
        status: 'PASSED',
        durationMs: 10,
        attemptCount: 1,
        stepResults: [], // 0 steps executed! Phantom pass
        evidenceIds: [],
      },
    ];

    const result = scorer.calculate({
      testResults,
      evidence: [],
      unverifiedAssertionsCount: 2,
      missingBaselinesCount: 1,
    });

    // 2 unverified assertions (2*15=30) + 1 missing baseline (20) + 1 phantom pass (15) = 65 penalty pts
    expect(result.honestyPenalty).toBeGreaterThanOrEqual(50);
    expect(result.score).toBeLessThanOrEqual(40);
    expect(result.summary).toContain('Honesty penalty');
  });

  it('penalizes confirmed findings that lack evidence artifacts', () => {
    const scorer = new TrustScorer();

    const findings: Finding[] = [
      {
        id: 'FIND-001',
        title: 'Critical unbacked finding',
        description: 'Agent claims bug exists but has zero screenshots or logs',
        severity: 'CRITICAL',
        status: 'CONFIRMED',
        fixVerification: 'UNVERIFIED',
        platform: 'web',
        preconditions: ['User is logged in'],
        reproductionSteps: ['Click button'],
        expectedBehavior: '200 OK',
        actualBehavior: '500 Error',
        evidenceIds: [], // Empty evidence!
        reproducibilityCount: 1,
        reproducibilitySuccessRate: 1.0,
        detectedAt: new Date().toISOString(),
        metadata: {},
      },
    ];

    const result = scorer.calculate({
      testResults: [
        {
          testCaseId: 'TC-1',
          title: 'Test',
          status: 'FAILED',
          durationMs: 100,
          attemptCount: 1,
          stepResults: [
            { stepId: 's1', status: 'FAILED', durationMs: 100, evidenceIds: [] },
          ],
          evidenceIds: [],
        },
      ],
      evidence: [],
      findings,
    });

    // Should penalize unbacked confirmed finding (-25 pts)
    expect(result.honestyPenalty).toBeGreaterThanOrEqual(25);
    expect(result.summary).toContain('Finding \'FIND-001\' claimed CONFIRMED without evidence');
  });

  it('handles edge case of 0 tests gracefully', () => {
    const result = TrustScorer.compute({
      testResults: [],
      evidence: [],
    });

    expect(result.score).toBe(0);
    expect(result.deterministicAssertionsCount).toBe(0);
    expect(result.summary).toContain('No test cases were executed');
  });

  it('penalizes reproducibility score when tests require multiple retries', () => {
    const scorer = new TrustScorer();

    const flakyResults: TestCaseResult[] = [
      {
        testCaseId: 'TC-FLAKY',
        title: 'Flaky login test',
        status: 'PASSED',
        durationMs: 500,
        attemptCount: 4, // passed after 4 attempts
        stepResults: [
          { stepId: 's1', status: 'PASSED', durationMs: 500, evidenceIds: [] },
        ],
        evidenceIds: [],
      },
    ];

    const result = scorer.calculate({
      testResults: flakyResults,
      evidence: [],
    });

    // 1 pass in 4 attempts = 25% test stability
    expect(result.reproducibilityScore).toBeLessThan(60);
  });

  it('clamps trust score between 0 and 100 even with massive penalties', () => {
    const scorer = new TrustScorer({ maxHonestyPenalty: 200 });
    const result = scorer.calculate({
      testResults: [
        {
          testCaseId: 'TC-1',
          title: 'Test',
          status: 'PASSED',
          durationMs: 10,
          attemptCount: 1,
          stepResults: [],
          evidenceIds: [],
        },
      ],
      evidence: [],
      unverifiedAssertionsCount: 20, // 20 * 15 = 300 pts penalty
    });

    expect(result.score).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('evaluates test results without a testPlan using step results', () => {
    const scorer = new TrustScorer();
    const result = scorer.calculate({
      testResults: [
        {
          testCaseId: 'TC-1',
          title: 'Test 1',
          status: 'PASSED',
          durationMs: 100,
          attemptCount: 1,
          stepResults: [
            { stepId: 's1', status: 'PASSED', durationMs: 50, evidenceIds: ['ev-1'] },
            { stepId: 's2', status: 'PASSED', durationMs: 50, evidenceIds: ['ev-1'] },
          ],
          evidenceIds: ['ev-1'],
        },
      ],
      evidence: [
        {
          id: 'ev-1',
          type: 'SCREENSHOT',
          path: '/tmp/ev1.png',
          sha256: 'a'.repeat(64),
          sizeBytes: 100,
          mimeType: 'image/png',
          capturedAt: new Date().toISOString(),
          description: '',
          metadata: {},
        },
      ],
    });

    expect(result.deterministicAssertionsCount).toBe(2);
    expect(result.score).toBeGreaterThan(60);
  });
});

describe('ReportFormatter', () => {
  let tempDir: string;
  let sampleReport: QARunReport;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-formatter-test-'));

    sampleReport = {
      runId: 'run-test-12345',
      projectName: 'Checkout Service Test Suite',
      targetApp: 'https://staging.shop.com',
      platform: 'web',
      startedAt: '2026-10-20T19:50:00.000Z',
      finishedAt: '2026-10-20T19:50:45.000Z',
      durationMs: 45000,
      overallStatus: 'FAILED',
      summary: {
        totalTests: 3,
        passed: 2,
        failed: 1,
        blocked: 0,
        skipped: 0,
        error: 0,
      },
      trustScore: {
        score: 78,
        deterministicAssertionsCount: 6,
        evidenceArtifactsCount: 2,
        reproducibilityScore: 90,
        coverageScore: 100,
        honestyPenalty: 0,
        summary: 'Moderate Trust: 78/100 backed by 6 assertions and 2 artifacts.',
      },
      capabilities: [
        {
          id: 'web-chromium',
          name: 'Playwright Chromium',
          platform: 'web',
          state: 'AVAILABLE',
          requiredTools: ['chromium'],
          missingTools: [],
          metadata: {},
        },
      ],
      testResults: [
        {
          testCaseId: 'TC-01',
          title: 'Catalog navigation',
          status: 'PASSED',
          durationMs: 1200,
          attemptCount: 1,
          evidenceIds: ['ev-shot-1'],
          stepResults: [
            { stepId: 'step-1', status: 'PASSED', durationMs: 600, evidenceIds: ['ev-shot-1'] },
            { stepId: 'step-2', status: 'PASSED', durationMs: 600, evidenceIds: [] },
          ],
        },
        {
          testCaseId: 'TC-02',
          title: 'Add item to shopping cart',
          status: 'PASSED',
          durationMs: 1800,
          attemptCount: 1,
          evidenceIds: [],
          stepResults: [
            { stepId: 'step-1', status: 'PASSED', durationMs: 900, evidenceIds: [] },
            { stepId: 'step-2', status: 'PASSED', durationMs: 900, evidenceIds: [] },
          ],
        },
        {
          testCaseId: 'TC-03',
          title: 'Apply promo discount code',
          status: 'FAILED',
          durationMs: 2500,
          attemptCount: 1,
          error: 'Expected discount banner to be visible',
          evidenceIds: ['ev-shot-1', 'ev-log-1'],
          stepResults: [
            { stepId: 'step-1', status: 'PASSED', durationMs: 1000, evidenceIds: [] },
            {
              stepId: 'step-2',
              status: 'FAILED',
              durationMs: 1500,
              error: 'Assertion failed: element not visible within 1500ms',
              evidenceIds: ['ev-shot-1', 'ev-log-1'],
            },
          ],
        },
      ],
      findings: [
        {
          id: 'FIND-404',
          title: 'Discount code does not apply coupon savings',
          description: 'Submitting valid coupon PROMO20 returns an unhandled 400 bad request error',
          severity: 'HIGH',
          status: 'CONFIRMED',
          fixVerification: 'UNVERIFIED',
          platform: 'web',
          testCaseId: 'TC-03',
          preconditions: ['User is on cart page with items totaling > $50'],
          reproductionSteps: [
            'Navigate to /cart',
            'Type PROMO20 into promo input',
            'Click Apply button',
          ],
          expectedBehavior: 'Discount of 20% displayed on order summary',
          actualBehavior: 'Network error 400 displayed in banner',
          evidenceIds: ['ev-shot-1', 'ev-log-1'],
          reproducibilityCount: 3,
          reproducibilitySuccessRate: 1.0,
          logsExcerpt: 'POST /api/coupons/apply 400 Bad Request: Invalid payload structure',
          detectedAt: '2026-10-20T19:50:30.000Z',
          metadata: {},
        },
      ],
      evidence: [
        {
          id: 'ev-shot-1',
          type: 'SCREENSHOT',
          path: path.join(tempDir, 'screenshot.png'),
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          sizeBytes: 1024,
          mimeType: 'image/png',
          capturedAt: '2026-10-20T19:50:31.000Z',
          description: 'Cart failure screenshot',
          metadata: {},
        },
        {
          id: 'ev-log-1',
          type: 'CONSOLE_LOG',
          path: path.join(tempDir, 'console.log'),
          sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
          sizeBytes: 256,
          mimeType: 'text/plain',
          capturedAt: '2026-10-20T19:50:32.000Z',
          description: 'Console log output',
          metadata: {},
        },
      ],
      environmentInfo: {
        os: 'darwin',
        node: 'v22.0.0',
        browser: 'chromium-120',
      },
    };

    // Create physical dummy evidence files for HTML dashboard embedding test
    await fs.writeFile(path.join(tempDir, 'screenshot.png'), Buffer.from('fake-png-content'));
    await fs.writeFile(path.join(tempDir, 'console.log'), 'POST /api/coupons/apply 400 Bad Request');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('formats and writes JSON report fully compliant with QARunReportSchema', async () => {
    const jsonStr = ReportFormatter.formatJson(sampleReport);
    expect(jsonStr).toBeTypeOf('string');

    // Validate with schema
    const parsed = QARunReportSchema.parse(JSON.parse(jsonStr));
    expect(parsed.runId).toBe(sampleReport.runId);
    expect(parsed.trustScore.score).toBe(78);

    // Test write and read roundtrip
    const jsonFile = path.join(tempDir, 'report.json');
    await ReportFormatter.writeJson(sampleReport, jsonFile);

    const readBack = await ReportFormatter.readJson(jsonFile);
    expect(readBack.runId).toBe(sampleReport.runId);
    expect(readBack.findings[0].id).toBe('FIND-404');
  });

  it('formats Markdown report with badges, executive summary, findings, and evidence links', async () => {
    const md = ReportFormatter.formatMarkdown(sampleReport);

    // Badges
    expect(md).toContain('![Status]');
    expect(md).toContain('![Trust Score]');
    expect(md).toContain('![Platform]');

    // Executive summary table
    expect(md).toContain('## Executive Summary');
    expect(md).toContain('https://staging.shop.com');
    expect(md).toContain('FAILED');

    // Trust Score section
    expect(md).toContain('## Trust & Integrity Score');
    expect(md).toContain('78/100');
    expect(md).toContain('Deterministic Assertions');

    // Test breakdown table
    expect(md).toContain('## Test Results Breakdown');
    expect(md).toContain('TC-01');
    expect(md).toContain('TC-03');
    expect(md).toContain('Apply promo discount code');

    // Detailed Findings
    expect(md).toContain('## Detailed Findings & Defects');
    expect(md).toContain('FIND-404');
    expect(md).toContain('[HIGH]');
    expect(md).toContain('Discount code does not apply coupon savings');
    expect(md).toContain('1. Navigate to /cart');
    expect(md).toContain('Expected:');
    expect(md).toContain('Actual:');

    // Evidence index
    expect(md).toContain('## Tamper-Evident Evidence Catalog');
    expect(md).toContain('ev-shot-1');
    expect(md).toContain('ev-log-1');

    // Write markdown to disk
    const mdFile = path.join(tempDir, 'report.md');
    await ReportFormatter.writeMarkdown(sampleReport, mdFile);
    const content = await fs.readFile(mdFile, 'utf-8');
    expect(content).toBe(md);
  });

  it('generates interactive standalone HTML dashboard with embedded screenshots and status filters', async () => {
    const html = await ReportFormatter.formatHtml(sampleReport, {
      embedArtifacts: true,
      evidenceBaseDir: tempDir,
    });

    // Check standalone HTML structure
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>QA Test Report: Checkout Service Test Suite</title>');

    // Check metrics and trust cards
    expect(html).toContain('Trust Score');
    expect(html).toContain('78');
    expect(html).toContain('Deterministic Assertions');

    // Check interactive filters and search
    expect(html).toContain('filterTests(\'all\')');
    expect(html).toContain('filterTests(\'PASSED\')');
    expect(html).toContain('filterTests(\'FAILED\')');
    expect(html).toContain('id="testSearch"');

    // Check embedded base64 image screenshot
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain('id="imageModal"');

    // Check findings rendering
    expect(html).toContain('FIND-404');
    expect(html).toContain('Discount code does not apply coupon savings');
    expect(html).toContain('Reproduction Steps');

    // Write HTML to disk
    const htmlFile = path.join(tempDir, 'report.html');
    await ReportFormatter.writeHtml(sampleReport, htmlFile, {
      embedArtifacts: true,
      evidenceBaseDir: tempDir,
    });

    const fileStat = await fs.stat(htmlFile);
    expect(fileStat.size).toBeGreaterThan(5000);
  });

  it('formats clean report when there are zero findings and zero evidence', () => {
    const cleanReport: QARunReport = {
      ...sampleReport,
      overallStatus: 'PASSED',
      findings: [],
      evidence: [],
      summary: {
        totalTests: 1,
        passed: 1,
        failed: 0,
        blocked: 0,
        skipped: 0,
        error: 0,
      },
    };

    const md = ReportFormatter.formatMarkdown(cleanReport);
    expect(md).toContain('*No defects or issues detected during this run.*');
    expect(md).toContain('*No evidence artifacts recorded.*');
  });

  it('rejects invalid report when validate is true', () => {
    const invalidReport = { ...sampleReport, overallStatus: 'UNKNOWN_STATUS' } as any;
    expect(() => ReportFormatter.formatJson(invalidReport, { validate: true })).toThrow();
  });

  it('formats HTML dashboard with embedArtifacts: false', async () => {
    const html = await ReportFormatter.formatHtml(sampleReport, { embedArtifacts: false });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).not.toContain('data:image/png;base64,');
  });
});

