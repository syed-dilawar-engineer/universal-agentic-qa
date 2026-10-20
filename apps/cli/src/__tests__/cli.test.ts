import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  createCli,
  runCli,
  DefaultEnvDetector,
  EnvDetector,
  runFullDoctor,
  generateDefaultConfig,
  generateTestPlan,
  validateTestPlanFile,
  CliMockAdapter,
} from '../index.js';
import { CapabilityRegistry } from '@agentic-qa/core';
import {
  QAConfigSchema,
  TestPlanSchema,
  QARunReport,
  Finding,
} from '@agentic-qa/schemas';

describe('Agentic QA CLI Test Suite', () => {
  let tempDir: string;
  let originalExitCode: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-qa-test-'));
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // Helper to run CLI in-process capturing stdout & stderr
  async function runCliCapture(args: string[], options: {
    envDetector?: EnvDetector;
    registryFactory?: () => CapabilityRegistry;
  } = {}) {
    const stdoutArr: string[] = [];
    const stderrArr: string[] = [];

    const exitCode = await runCli(['node', 'qa', ...args], {
      stdout: (msg) => stdoutArr.push(msg),
      stderr: (msg) => stderrArr.push(msg),
      envDetector: options.envDetector,
      registryFactory: options.registryFactory,
      exitOverride: true,
    });

    const stdout = stdoutArr.join('\n');
    const stderr = stderrArr.join('\n');

    let json: any = undefined;
    try {
      json = JSON.parse(stdout);
    } catch {
      // Not JSON
    }

    return { exitCode, stdout, stderr, json };
  }

  // ==========================================================================
  // 1. Argument Parsing & Help
  // ==========================================================================
  describe('Argument Parsing & Commands', () => {
    it('outputs help listing all 10 required commands', async () => {
      const cli = createCli();
      const registeredCommands = cli.commands.map(c => c.name());

      expect(registeredCommands).toContain('doctor');
      expect(registeredCommands).toContain('init');
      expect(registeredCommands).toContain('capabilities');
      expect(registeredCommands).toContain('inspect');
      expect(registeredCommands).toContain('plan');
      expect(registeredCommands).toContain('test');
      expect(registeredCommands).toContain('explore');
      expect(registeredCommands).toContain('visual');
      expect(registeredCommands).toContain('report');
      expect(registeredCommands).toContain('verify-fix');
    });

    it('displays version number correctly', async () => {
      const cli = createCli();
      expect(cli.version()).toBe('0.1.0');
    });
  });

  // ==========================================================================
  // 2. Doctor Checks
  // ==========================================================================
  describe('qa doctor', () => {
    it('detects healthy runtimes and tools on current environment', async () => {
      const { exitCode, stdout, json } = await runCliCapture(['doctor', '--json']);
      expect(exitCode).toBe(0);
      expect(json).toBeDefined();
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.checks)).toBe(true);

      const nodeCheck = json.checks.find((c: any) => c.name === 'Node.js');
      expect(nodeCheck).toBeDefined();
      expect(nodeCheck.status).toBe('ok');

      const adapterCheck = json.checks.find((c: any) => c.category === 'adapter');
      expect(adapterCheck).toBeDefined();
    });

    it('reports failure when Node.js version is below requirement', async () => {
      const mockEnv: EnvDetector = {
        checkCommand: () => ({ success: true, output: '3.11.0' }),
        checkPath: () => false,
        getNodeVersion: () => 'v18.15.0',
        getPlatform: () => 'linux',
        getArch: () => 'x64',
      };

      const { exitCode, json } = await runCliCapture(['doctor', '--json'], { envDetector: mockEnv });
      expect(json.ok).toBe(false); // Node 18 is below >= 20 requirement
      const nodeCheck = json.checks.find((c: any) => c.name === 'Node.js');
      expect(nodeCheck.status).toBe('warning');
    });

    it('detects missing tools truthfully without crashing', async () => {
      const mockEnv: EnvDetector = {
        checkCommand: () => ({ success: false, output: 'command not found' }),
        checkPath: () => false,
        getNodeVersion: () => 'v20.10.0',
        getPlatform: () => 'linux',
        getArch: () => 'x64',
      };

      const { stdout, json } = await runCliCapture(['doctor', '--json'], { envDetector: mockEnv });
      expect(json).toBeDefined();
      const adbCheck = json.checks.find((c: any) => c.name.includes('adb'));
      expect(adbCheck.status).toBe('missing');
    });
  });

  // ==========================================================================
  // 3. Init Command
  // ==========================================================================
  describe('qa init', () => {
    it('generates standard qa.config.json template', async () => {
      const configPath = path.join(tempDir, 'qa.config.json');
      const { exitCode, stdout, json } = await runCliCapture(['init', '--path', configPath, '--json']);

      expect(exitCode).toBe(0);
      expect(json.success).toBe(true);
      expect(fs.existsSync(configPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const parsed = QAConfigSchema.safeParse(content);
      expect(parsed.success).toBe(true);
      expect(content.target.platform).toBe('web');
      expect(content.viewports).toHaveLength(5);
    });

    it('fails when config already exists and --force is not specified', async () => {
      const configPath = path.join(tempDir, 'qa.config.json');
      fs.writeFileSync(configPath, '{"existing": true}');

      const { exitCode, stdout, json } = await runCliCapture(['init', '--path', configPath, '--json']);
      expect(exitCode).toBe(1);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });

    it('overwrites existing config when --force is provided', async () => {
      const configPath = path.join(tempDir, 'qa.config.json');
      fs.writeFileSync(configPath, '{"existing": true}');

      const { exitCode, json } = await runCliCapture(['init', '--path', configPath, '--force', '--json']);
      expect(exitCode).toBe(0);
      expect(json.success).toBe(true);
      const content = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(content.name).toBe('agentic-qa-project');
    });
  });

  // ==========================================================================
  // 4. Capabilities Command
  // ==========================================================================
  describe('qa capabilities', () => {
    it('probes and lists registered capabilities in table and json format', async () => {
      const registry = new CapabilityRegistry();
      registry.registerAdapter(new CliMockAdapter({ id: 'mock-web', name: 'Mock Web', platform: 'web', state: 'AVAILABLE' }));
      registry.registerAdapter(new CliMockAdapter({ id: 'mock-mob', name: 'Mock Mob', platform: 'mobile', state: 'BLOCKED' }));

      const { exitCode, json } = await runCliCapture(['capabilities', '--json'], {
        registryFactory: () => registry,
      });

      expect(exitCode).toBe(0);
      expect(json.count).toBe(2);
      expect(json.capabilities[0].id).toBe('mock-web');
      expect(json.capabilities[0].state).toBe('AVAILABLE');
      expect(json.capabilities[1].id).toBe('mock-mob');
      expect(json.capabilities[1].state).toBe('BLOCKED');
    });
  });

  // ==========================================================================
  // 5. Inspect Command
  // ==========================================================================
  describe('qa inspect', () => {
    it('inspects a directory and detects Node / framework', async () => {
      const pkgJson = path.join(tempDir, 'package.json');
      fs.writeFileSync(pkgJson, JSON.stringify({ name: 'my-vite-app', dependencies: { vite: '^5.0.0' } }));

      const { exitCode, json } = await runCliCapture(['inspect', tempDir, '--json']);
      expect(exitCode).toBe(0);
      expect(json.targetType).toBe('directory');
      expect(json.framework).toBe('Vite');
      expect(json.platform).toBe('web');
      expect(json.recommendations.suggestedAdapters).toContain('web-standard');
    });

    it('inspects a URL target', async () => {
      const { exitCode, json } = await runCliCapture(['inspect', 'https://example.com', '--json']);
      expect(exitCode).toBe(0);
      expect(json.targetType).toBe('url');
      expect(json.platform).toBe('web');
      expect(json.details.host).toBe('example.com');
    });
  });

  // ==========================================================================
  // 6. Plan Command
  // ==========================================================================
  describe('qa plan', () => {
    it('generates a valid test plan conforming to TestPlanSchema', async () => {
      const planFile = path.join(tempDir, 'generated-plan.json');
      const { exitCode, json } = await runCliCapture([
        'plan',
        '--generate',
        '--target', 'http://localhost:3000',
        '--out', planFile,
        '--json',
      ]);

      expect(exitCode).toBe(0);
      expect(json.targetApp).toBe('http://localhost:3000');
      expect(json.scenarios).toHaveLength(2);

      const parsed = TestPlanSchema.safeParse(json);
      expect(parsed.success).toBe(true);
      expect(fs.existsSync(planFile)).toBe(true);
    });

    it('validates an existing test plan successfully', async () => {
      const plan = generateTestPlan({ target: 'http://localhost:3000' });
      const planFile = path.join(tempDir, 'valid-plan.json');
      fs.writeFileSync(planFile, JSON.stringify(plan));

      const { exitCode, json } = await runCliCapture(['plan', '--validate', planFile, '--json']);
      expect(exitCode).toBe(0);
      expect(json.valid).toBe(true);
      expect(json.scenariosCount).toBe(2);
    });

    it('fails validation on corrupted or invalid plan JSON', async () => {
      const invalidFile = path.join(tempDir, 'invalid-plan.json');
      fs.writeFileSync(invalidFile, '{"broken": true}');

      const { exitCode, json } = await runCliCapture(['plan', '--validate', invalidFile, '--json']);
      expect(exitCode).toBe(1);
      expect(json.valid).toBe(false);
      expect(json.errors).toBeDefined();
    });
  });

  // ==========================================================================
  // 7. Test Command & Exit Codes (0 for pass, 1 for fail, 2 for blocked)
  // ==========================================================================
  describe('qa test execution and exit codes', () => {
    it('returns exit code 0 when all tests pass', async () => {
      const registry = new CapabilityRegistry();
      registry.registerAdapter(new CliMockAdapter({ id: 'web-pass', platform: 'web', state: 'AVAILABLE' }));

      const plan = generateTestPlan({ target: 'http://localhost:3000' });
      const planFile = path.join(tempDir, 'plan-pass.json');
      fs.writeFileSync(planFile, JSON.stringify(plan));
      const reportOut = path.join(tempDir, 'report-pass.json');

      const { exitCode, json } = await runCliCapture([
        'test',
        '--plan', planFile,
        '--adapter', 'web-pass',
        '--out', reportOut,
        '--json',
      ], { registryFactory: () => registry });

      expect(exitCode).toBe(0);
      expect(json.overallStatus).toBe('PASSED');
      expect(json.summary.passed).toBe(2);
      expect(json.summary.failed).toBe(0);
      expect(fs.existsSync(reportOut)).toBe(true);
    });

    it('returns exit code 1 when test assertions fail', async () => {
      const registry = new CapabilityRegistry();
      registry.registerAdapter(
        new CliMockAdapter({
          id: 'web-fail',
          platform: 'web',
          state: 'AVAILABLE',
          failAssertions: true,
        })
      );

      const plan = generateTestPlan({ target: 'http://localhost:3000' });
      const planFile = path.join(tempDir, 'plan-fail.json');
      fs.writeFileSync(planFile, JSON.stringify(plan));

      const { exitCode, json } = await runCliCapture([
        'test',
        '--plan', planFile,
        '--adapter', 'web-fail',
        '--json',
      ], { registryFactory: () => registry });

      expect(exitCode).toBe(1);
      expect(json.overallStatus).toBe('FAILED');
      expect(json.summary.failed).toBeGreaterThan(0);
      expect(json.findings.length).toBeGreaterThan(0);
    });

    it('returns exit code 2 when adapter execution is BLOCKED', async () => {
      const registry = new CapabilityRegistry();
      registry.registerAdapter(
        new CliMockAdapter({
          id: 'web-blocked',
          platform: 'web',
          state: 'BLOCKED',
          reason: 'Missing Playwright binaries',
          missingTools: ['playwright'],
        })
      );

      const plan = generateTestPlan({ target: 'http://localhost:3000' });
      const planFile = path.join(tempDir, 'plan-block.json');
      fs.writeFileSync(planFile, JSON.stringify(plan));

      const { exitCode, json } = await runCliCapture([
        'test',
        '--plan', planFile,
        '--adapter', 'web-blocked',
        '--json',
      ], { registryFactory: () => registry });

      expect(exitCode).toBe(2);
      expect(json.overallStatus).toBe('BLOCKED');
      expect(json.error).toContain('BLOCKED');
    });
  });

  // ==========================================================================
  // 8. Explore Command
  // ==========================================================================
  describe('qa explore', () => {
    it('executes bounded exploratory monkey testing and produces report', async () => {
      const registry = new CapabilityRegistry();
      registry.registerAdapter(new CliMockAdapter({ id: 'web-standard', platform: 'web', state: 'AVAILABLE' }));

      const reportOut = path.join(tempDir, 'explore-report.json');
      const { exitCode, json } = await runCliCapture([
        'explore',
        'http://localhost:3000',
        '--max-steps', '5',
        '--seed', '123',
        '--out', reportOut,
        '--json',
      ], { registryFactory: () => registry });

      expect(exitCode).toBe(0);
      expect(json.overallStatus).toBe('PASSED');
      expect(json.exploratoryDetails.mode).toBe('exploratory');
      expect(json.exploratoryDetails.seed).toBe(123);
      expect(fs.existsSync(reportOut)).toBe(true);
    });
  });

  // ==========================================================================
  // 9. Visual Command
  // ==========================================================================
  describe('qa visual', () => {
    it('runs visual check and updates baselines', async () => {
      const registry = new CapabilityRegistry();
      registry.registerAdapter(new CliMockAdapter({ id: 'web-standard', platform: 'web', state: 'AVAILABLE' }));
      const baselineDir = path.join(tempDir, 'baselines');

      const { exitCode, json } = await runCliCapture([
        'visual',
        'http://localhost:3000',
        '--baseline-dir', baselineDir,
        '--update-baselines',
        '--viewports', 'desktop,tablet',
        '--json',
      ], { registryFactory: () => registry });

      expect(exitCode).toBe(0);
      expect(json.overallStatus).toBe('PASSED');
      expect(fs.existsSync(path.join(baselineDir, 'desktop.png'))).toBe(true);
      expect(fs.existsSync(path.join(baselineDir, 'tablet.png'))).toBe(true);
    });
  });

  // ==========================================================================
  // 10. Report Command
  // ==========================================================================
  describe('qa report', () => {
    it('formats and outputs report in JSON and text format', async () => {
      const registry = new CapabilityRegistry();
      registry.registerAdapter(new CliMockAdapter({ id: 'web-standard', platform: 'web', state: 'AVAILABLE' }));
      const plan = generateTestPlan({ target: 'http://localhost:3000' });
      const planFile = path.join(tempDir, 'plan.json');
      fs.writeFileSync(planFile, JSON.stringify(plan));
      const reportFile = path.join(tempDir, 'saved-report.json');

      await runCliCapture(['test', '--plan', planFile, '--out', reportFile, '--json'], {
        registryFactory: () => registry,
      });

      // View report JSON
      const { exitCode, json } = await runCliCapture(['report', reportFile, '--json']);
      expect(exitCode).toBe(0);
      expect(json.projectName).toBe(plan.name);

      // View report markdown
      const mdResult = await runCliCapture(['report', reportFile, '--format', 'markdown']);
      expect(mdResult.exitCode).toBe(0);
      expect(mdResult.stdout).toContain('# QA Run Report:');
    });
  });

  // ==========================================================================
  // 11. Verify-Fix Command
  // ==========================================================================
  describe('qa verify-fix', () => {
    it('outputs VERIFIED and exit code 0 when fix rerun passes', async () => {
      // Create a report with a failed finding
      const failedFinding: Finding = {
        id: 'FIND-101',
        title: 'Broken submit button',
        description: 'Button throws 500 error',
        severity: 'HIGH',
        status: 'CONFIRMED',
        fixVerification: 'UNVERIFIED',
        platform: 'web',
        preconditions: ['User on checkout page'],
        reproductionSteps: ['Click submit button on checkout page'],
        expectedBehavior: 'HTTP 200',
        actualBehavior: 'HTTP 500',
        evidenceIds: [],
        reproducibilityCount: 1,
        reproducibilitySuccessRate: 1.0,
        detectedAt: new Date().toISOString(),
        metadata: {},
      };

      const prevReport: QARunReport = {
        runId: 'prev-run-1',
        projectName: 'Fix Verification App',
        targetApp: 'http://localhost:3000',
        platform: 'web',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 50,
        overallStatus: 'FAILED',
        summary: { totalTests: 1, passed: 0, failed: 1, blocked: 0, skipped: 0, error: 0 },
        trustScore: { score: 0, deterministicAssertionsCount: 1, evidenceArtifactsCount: 0, reproducibilityScore: 100, coverageScore: 100, honestyPenalty: 0, summary: '' },
        capabilities: [],
        testResults: [{
          testCaseId: 'test-1',
          title: 'Submit button check',
          status: 'FAILED',
          durationMs: 50,
          stepResults: [],
          evidenceIds: [],
          attemptCount: 1,
        }],
        findings: [failedFinding],
        evidence: [],
        environmentInfo: {},
      };

      const reportPath = path.join(tempDir, 'prev-report.json');
      fs.writeFileSync(reportPath, JSON.stringify(prevReport));

      // Now adapter is FIXED and passes
      const registry = new CapabilityRegistry();
      registry.registerAdapter(new CliMockAdapter({ id: 'web-standard', platform: 'web', state: 'AVAILABLE' }));

      const { exitCode, stdout, json } = await runCliCapture([
        'verify-fix',
        '--report', reportPath,
        '--finding', 'FIND-101',
        '--json',
      ], { registryFactory: () => registry });

      expect(exitCode).toBe(0);
      expect(json.status).toBe('VERIFIED');
      expect(json.verified).toBe(true);
    });

    it('outputs FAILED and exit code 1 when fix rerun fails', async () => {
      const prevReport: QARunReport = {
        runId: 'prev-run-2',
        projectName: 'Still Broken App',
        targetApp: 'http://localhost:3000',
        platform: 'web',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 50,
        overallStatus: 'FAILED',
        summary: { totalTests: 1, passed: 0, failed: 1, blocked: 0, skipped: 0, error: 0 },
        trustScore: { score: 0, deterministicAssertionsCount: 1, evidenceArtifactsCount: 0, reproducibilityScore: 100, coverageScore: 100, honestyPenalty: 0, summary: '' },
        capabilities: [],
        testResults: [{
          testCaseId: 'test-1',
          title: 'Submit button check',
          status: 'FAILED',
          durationMs: 50,
          stepResults: [],
          evidenceIds: [],
          attemptCount: 1,
        }],
        findings: [],
        evidence: [],
        environmentInfo: {},
      };

      const reportPath = path.join(tempDir, 'prev-report-2.json');
      fs.writeFileSync(reportPath, JSON.stringify(prevReport));

      // Adapter still fails
      const registry = new CapabilityRegistry();
      registry.registerAdapter(new CliMockAdapter({
        id: 'web-standard',
        platform: 'web',
        state: 'AVAILABLE',
        failAssertions: true,
      }));

      const { exitCode, json } = await runCliCapture([
        'verify-fix',
        '--report', reportPath,
        '--json',
      ], { registryFactory: () => registry });

      expect(exitCode).toBe(1);
      expect(json.status).toBe('FAILED');
      expect(json.verified).toBe(false);
    });
  });

  // ==========================================================================
  // 12. Binary Execution Integration Test
  // ==========================================================================
  describe('Binary Shebang Execution (bin/qa.js)', () => {
    it('executes directly via Node child process', () => {
      const binPath = path.resolve(__dirname, '../../bin/qa.js');
      const output = execFileSync(process.execPath, [binPath, 'doctor', '--json'], {
        encoding: 'utf8',
      });
      const parsed = JSON.parse(output);
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.checks)).toBe(true);
    });
  });
});
