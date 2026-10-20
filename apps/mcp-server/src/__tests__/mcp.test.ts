import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CapabilityRegistry } from '@agentic-qa/core';
import { TestPlan, TestCase } from '@agentic-qa/schemas';
import {
  createMcpServer,
  RunStorage,
  MockPlatformAdapter,
  TOOL_NAMES,
  handleDiscoverCapabilities,
  handleInspectTarget,
  handleCreatePlan,
  handleExecuteTest,
  handleGetEvidence,
  handleGenerateReport,
  handleVerifyFix,
} from '../index.js';

describe('MCP Tools Unit Tests', () => {
  let registry: CapabilityRegistry;
  let storage: RunStorage;
  let mockAdapter: MockPlatformAdapter;

  beforeEach(() => {
    registry = new CapabilityRegistry();
    storage = new RunStorage();
    mockAdapter = new MockPlatformAdapter({
      id: 'mock-web',
      name: 'Mock Web Adapter',
      platform: 'web',
      state: 'AVAILABLE',
    });
    registry.registerAdapter(mockAdapter);
  });

  // ==========================================================================
  // 1. qa_discover_capabilities
  // ==========================================================================
  describe('qa_discover_capabilities', () => {
    it('returns honest capability states across adapters and system', async () => {
      const result = await handleDiscoverCapabilities(
        { forceRefresh: true, detailed: true },
        { registry, storage }
      );

      expect(result.capabilities.length).toBeGreaterThan(0);
      expect(result.summary.total).toBe(result.capabilities.length);
      expect(['ALL_READY', 'PARTIALLY_READY', 'NOT_READY']).toContain(result.readiness);

      // Verify mock adapter is listed
      const mock = result.capabilities.find((c) => c.id === 'mock-web');
      expect(mock).toBeDefined();
      expect(mock?.state).toBe('AVAILABLE');

      // Verify system prober results are present
      const webBrowser = result.capabilities.find((c) => c.id === 'system-web-browser');
      expect(webBrowser).toBeDefined();
      expect(['AVAILABLE', 'BLOCKED']).toContain(webBrowser?.state);
    });

    it('filters capabilities by platform', async () => {
      const result = await handleDiscoverCapabilities(
        { platform: 'web', detailed: false },
        { registry, storage }
      );

      expect(result.capabilities.every((c) => c.platform === 'web')).toBe(true);
      expect(result.capabilities.some((c) => c.platform === 'mobile')).toBe(false);
    });

    it('provides truthful recommendations when a tool is BLOCKED', async () => {
      const blockedAdapter = new MockPlatformAdapter({
        id: 'blocked-mobile',
        name: 'Blocked Mobile',
        platform: 'mobile',
        state: 'BLOCKED',
        missingTools: ['adb'],
      });
      registry.registerAdapter(blockedAdapter);

      const result = await handleDiscoverCapabilities(
        { platform: 'mobile', detailed: true },
        { registry, storage }
      );

      const blocked = result.capabilities.find((c) => c.id === 'blocked-mobile');
      expect(blocked?.state).toBe('BLOCKED');
      expect(result.recommendations.some((r) => r.includes('adb'))).toBe(true);
    });
  });

  // ==========================================================================
  // 2. qa_inspect_target
  // ==========================================================================
  describe('qa_inspect_target', () => {
    it('inspects a local directory target and detects project details', async () => {
      const result = await handleInspectTarget(
        { target: process.cwd() },
        { registry, storage }
      );

      expect(result.reachable).toBe(true);
      expect(result.targetType).toBe('LOCAL_DIRECTORY');
      expect(result.details.isDirectory).toBe(true);
      expect(result.recommendations.length).toBeGreaterThan(0);
    });

    it('inspects a local file target and infers platform', async () => {
      const pkgJsonPath = `${process.cwd()}/package.json`;
      const result = await handleInspectTarget(
        { target: pkgJsonPath },
        { registry, storage }
      );

      expect(result.reachable).toBe(true);
      expect(result.targetType).toBe('LOCAL_FILE');
      expect(result.inferredPlatform).toBe('api');
      expect(result.details.sizeBytes).toBeGreaterThan(0);
    });

    it('returns honest error for non-existent local target', async () => {
      const result = await handleInspectTarget(
        { target: '/non/existent/path/for/sure' },
        { registry, storage }
      );

      expect(result.reachable).toBe(false);
      expect(result.error).toContain('Local path does not exist');
    });

    it('handles unreachable URL target gracefully without crashing', async () => {
      const result = await handleInspectTarget(
        { target: 'http://127.0.0.1:59999/unreachable-endpoint', timeoutMs: 1500 },
        { registry, storage }
      );

      expect(result.reachable).toBe(false);
      expect(result.targetType).toBe('URL');
      expect(result.error).toBeDefined();
    });
  });

  // ==========================================================================
  // 3. qa_create_plan
  // ==========================================================================
  describe('qa_create_plan', () => {
    it('generates a strictly-typed smoke test plan conforming to schema', async () => {
      const result = await handleCreatePlan(
        {
          action: 'generate',
          targetApp: 'https://example.com',
          platform: 'web',
          planType: 'smoke',
        },
        { registry, storage }
      );

      expect(result.valid).toBe(true);
      expect(result.plan).toBeDefined();
      expect(result.plan?.targetApp).toBe('https://example.com');
      expect(result.plan?.platform).toBe('web');
      expect(result.scenarioCount).toBeGreaterThanOrEqual(1);
      expect(result.plan?.scenarios[0].steps.length).toBeGreaterThanOrEqual(2);

      // Verify cached in storage
      const cached = storage.getPlan(result.plan!.planId);
      expect(cached).toBeDefined();
    });

    it('generates accessibility and robustness test plans', async () => {
      const a11yResult = await handleCreatePlan(
        {
          action: 'generate',
          targetApp: 'https://example.com',
          platform: 'web',
          planType: 'accessibility',
        },
        { registry, storage }
      );
      expect(a11yResult.valid).toBe(true);
      expect(a11yResult.plan?.scenarios[0].steps.some((s) => s.assertion?.type === 'noAccessibilityViolations')).toBe(true);

      const robustResult = await handleCreatePlan(
        {
          action: 'generate',
          targetApp: 'https://example.com',
          platform: 'web',
          planType: 'robustness',
        },
        { registry, storage }
      );
      expect(robustResult.valid).toBe(true);
      expect(robustResult.plan?.scenarios[0].steps.some((s) => s.action?.type === 'rapidClicks')).toBe(true);
    });

    it('validates valid existing plans', async () => {
      const generated = await handleCreatePlan(
        { action: 'generate', targetApp: 'https://example.com', planType: 'smoke' },
        { registry, storage }
      );

      const validation = await handleCreatePlan(
        { action: 'validate', plan: generated.plan },
        { registry, storage }
      );

      expect(validation.valid).toBe(true);
      expect(validation.scenarioCount).toBe(generated.plan?.scenarios.length);
    });

    it('validates invalid plans and returns structured errors without throwing', async () => {
      const invalidPlan = {
        name: 'Invalid Plan Missing Required Fields',
        // missing planId, targetApp, platform, createdAt, scenarios
      };

      const validation = await handleCreatePlan(
        { action: 'validate', plan: invalidPlan as any },
        { registry, storage }
      );

      expect(validation.valid).toBe(false);
      expect(validation.errors).toBeDefined();
      expect(validation.errors!.length).toBeGreaterThan(0);
      expect(validation.errors!.some((e) => e.path.includes('targetApp') || e.path.includes('platform'))).toBe(true);
    });
  });

  // ==========================================================================
  // 4. qa_execute_test
  // ==========================================================================
  describe('qa_execute_test', () => {
    it('executes a passing test plan and stores report with trust score', async () => {
      const planRes = await handleCreatePlan(
        { action: 'generate', targetApp: 'https://example.com', planType: 'smoke' },
        { registry, storage }
      );

      const execRes = await handleExecuteTest(
        { plan: planRes.plan },
        { registry, storage }
      );

      expect(execRes.overallStatus).toBe('PASSED');
      expect(execRes.summary.totalTests).toBe(1);
      expect(execRes.summary.passed).toBe(1);
      expect(execRes.summary.failed).toBe(0);
      expect(execRes.trustScore.score).toBeGreaterThan(0);
      expect(execRes.findingsCount).toBe(0);

      // Verify stored in RunStorage
      const savedReport = storage.getReport(execRes.runId);
      expect(savedReport).toBeDefined();
      expect(savedReport?.overallStatus).toBe('PASSED');
    });

    it('executes a failing test, records findings, captures evidence', async () => {
      // Create a test plan with a step designed to fail
      const plan: TestPlan = {
        planId: 'plan-failing-test',
        name: 'Failing Test Scenario',
        targetApp: 'https://example.com',
        platform: 'web',
        environment: 'local',
        createdAt: new Date().toISOString(),
        metadata: {},
        scenarios: [
          {
            id: 'tc-fail-1',
            title: 'Verify modal is hidden',
            description: 'Expects elementVisible: false, which our mock will fail',
            platform: 'web',
            timeoutMs: 10000,
            retries: 0,
            tags: ['ui'],
            expectedOutcome: 'PASS',
            steps: [
              {
                id: 'step-1',
                description: 'Check modal is hidden',
                assertion: {
                  type: 'elementVisible',
                  expected: false,
                  critical: true,
                  metadata: {},
                },
                continueOnFailure: false,
              },
            ],
          },
        ],
      };

      const execRes = await handleExecuteTest(
        { plan },
        { registry, storage }
      );

      expect(execRes.overallStatus).toBe('FAILED');
      expect(execRes.summary.failed).toBe(1);
      expect(execRes.findingsCount).toBe(1);
      expect(execRes.findings[0].severity).toBe('HIGH');
      expect(execRes.findings[0].status).toBe('CONFIRMED');
      expect(execRes.evidenceIds.length).toBeGreaterThan(0);

      // Verify finding is saved in storage
      const findingId = execRes.findings[0].id;
      const storedFinding = storage.getFinding(findingId);
      expect(storedFinding).toBeDefined();
    });

    it('fails honestly when adapter capability is BLOCKED', async () => {
      mockAdapter.setState('BLOCKED', ['chromium']);

      const planRes = await handleCreatePlan(
        { action: 'generate', targetApp: 'https://example.com' },
        { registry, storage }
      );

      await expect(
        handleExecuteTest({ plan: planRes.plan }, { registry, storage })
      ).rejects.toThrow(/Execution blocked/i);
    });
  });

  // ==========================================================================
  // 5. qa_get_evidence
  // ==========================================================================
  describe('qa_get_evidence', () => {
    it('retrieves evidence artifact with verified sha256 checksum', async () => {
      // Capture mock evidence
      const ev = await mockAdapter.captureEvidence('SCREENSHOT', 'Landing page screenshot');
      storage.saveEvidence(ev);

      // Retrieve metadata only
      const metaRes = await handleGetEvidence(
        { evidenceId: ev.id, encoding: 'metadata_only' },
        { registry, storage }
      );
      expect(metaRes.found).toBe(true);
      expect(metaRes.artifact?.id).toBe(ev.id);
      expect(metaRes.verifiedChecksum).toBe(true);
      expect(metaRes.data).toBeUndefined();

      // Retrieve utf8 content with checksum verification
      const dataRes = await handleGetEvidence(
        { evidenceId: ev.id, encoding: 'utf8' },
        { registry, storage }
      );
      expect(dataRes.found).toBe(true);
      expect(dataRes.verifiedChecksum).toBe(true);
      expect(dataRes.data).toContain('MOCK_EVIDENCE_CONTENT');
    });

    it('returns honest not-found response for non-existent evidence ID', async () => {
      const res = await handleGetEvidence(
        { evidenceId: 'non-existent-id' },
        { registry, storage }
      );
      expect(res.found).toBe(false);
      expect(res.verifiedChecksum).toBe(false);
      expect(res.error).toContain('not found');
    });
  });

  // ==========================================================================
  // 6. qa_generate_report
  // ==========================================================================
  describe('qa_generate_report', () => {
    it('generates markdown report from latest test execution', async () => {
      const planRes = await handleCreatePlan(
        { action: 'generate', targetApp: 'https://example.com' },
        { registry, storage }
      );
      await handleExecuteTest({ plan: planRes.plan }, { registry, storage });

      const reportRes = await handleGenerateReport(
        { format: 'markdown', includeEvidence: true },
        { registry, storage }
      );

      expect(reportRes.format).toBe('markdown');
      expect(reportRes.overallStatus).toBe('PASSED');
      expect(reportRes.content).toContain('QA Run Report:');
      expect(reportRes.content).toContain('Truth & Trust Score Breakdown');
      expect(reportRes.content).toContain('Test Suite Execution Summary');
    });

    it('generates formatted JSON and summary reports', async () => {
      const planRes = await handleCreatePlan(
        { action: 'generate', targetApp: 'https://example.com' },
        { registry, storage }
      );
      const exec = await handleExecuteTest({ plan: planRes.plan }, { registry, storage });

      const jsonRes = await handleGenerateReport(
        { runId: exec.runId, format: 'json' },
        { registry, storage }
      );
      expect(jsonRes.format).toBe('json');
      const parsed = JSON.parse(jsonRes.content);
      expect(parsed.runId).toBe(exec.runId);

      const summaryRes = await handleGenerateReport(
        { runId: exec.runId, format: 'summary' },
        { registry, storage }
      );
      expect(summaryRes.format).toBe('summary');
      expect(summaryRes.content).toContain('QA Execution Summary');
    });

    it('throws error when no report exists and no runId provided', async () => {
      const freshStorage = new RunStorage();
      await expect(
        handleGenerateReport({ format: 'markdown' }, { registry, storage: freshStorage })
      ).rejects.toThrow(/No previous QA execution found/);
    });
  });

  // ==========================================================================
  // 7. qa_verify_fix
  // ==========================================================================
  describe('qa_verify_fix', () => {
    it('truthfully verifies fix when regression test passes', async () => {
      // 1. Run a test that produces a finding
      const plan: TestPlan = {
        planId: 'plan-bug',
        name: 'Defect Detection Run',
        targetApp: 'https://example.com',
        platform: 'web',
        environment: 'local',
        createdAt: new Date().toISOString(),
        metadata: {},
        scenarios: [
          {
            id: 'tc-bug',
            title: 'Broken button assertion',
            description: 'Button is expected to be hidden',
            platform: 'web',
            timeoutMs: 10000,
            retries: 0,
            tags: ['regression'],
            expectedOutcome: 'PASS',
            steps: [
              {
                id: 'step-assert',
                description: 'Assert button hidden',
                assertion: {
                  type: 'elementVisible',
                  expected: false,
                  critical: true,
                  metadata: {},
                },
                continueOnFailure: false,
              },
            ],
          },
        ],
      };

      const execRes = await handleExecuteTest({ plan }, { registry, storage });
      expect(execRes.findings.length).toBe(1);
      const findingId = execRes.findings[0].id;

      // 2. Simulate developer fix: assertion now passes!
      mockAdapter.setAssertionOverride('elementVisible', { passed: true });

      // 3. Verify fix
      const verifyRes = await handleVerifyFix({ findingId }, { registry, storage });

      expect(verifyRes.verified).toBe(true);
      expect(verifyRes.newStatus).toBe('FIX_VERIFIED');
      expect(verifyRes.fixVerification).toBe('VERIFIED');
      expect(verifyRes.message).toContain('TRUTHFULLY VERIFIED AS FIXED');

      // Verify stored finding status was updated
      const updatedFinding = storage.getFinding(findingId);
      expect(updatedFinding?.status).toBe('FIX_VERIFIED');
      expect(updatedFinding?.fixVerification).toBe('VERIFIED');
    });

    it('truthfully reports FIX_FAILED when defect is still reproducing', async () => {
      // 1. Run a test that produces a finding
      const plan: TestPlan = {
        planId: 'plan-persistent-bug',
        name: 'Persistent Bug Run',
        targetApp: 'https://example.com',
        platform: 'web',
        environment: 'local',
        createdAt: new Date().toISOString(),
        metadata: {},
        scenarios: [
          {
            id: 'tc-persistent',
            title: 'Persistent failing element',
            description: 'Failing step',
            platform: 'web',
            timeoutMs: 10000,
            retries: 0,
            tags: ['bug'],
            expectedOutcome: 'PASS',
            steps: [
              {
                id: 'step-fail',
                description: 'Step that keeps failing',
                assertion: {
                  type: 'elementVisible',
                  expected: false,
                  critical: true,
                  metadata: {},
                },
                continueOnFailure: false,
              },
            ],
          },
        ],
      };

      const execRes = await handleExecuteTest({ plan }, { registry, storage });
      const findingId = execRes.findings[0].id;

      // Bug NOT fixed: override to keep failing
      mockAdapter.setAssertionOverride('elementVisible', {
        passed: false,
        message: 'Element is STILL visible after attempted fix',
      });

      // 2. Verify fix
      const verifyRes = await handleVerifyFix({ findingId }, { registry, storage });

      expect(verifyRes.verified).toBe(false);
      expect(verifyRes.newStatus).toBe('FIX_FAILED');
      expect(verifyRes.fixVerification).toBe('FAILED');
      expect(verifyRes.message).toContain('FIX FAILED');

      // Verify stored finding status was updated to FIX_FAILED
      const updatedFinding = storage.getFinding(findingId);
      expect(updatedFinding?.status).toBe('FIX_FAILED');
      expect(updatedFinding?.fixVerification).toBe('FAILED');
    });
  });

  // ==========================================================================
  // 8. End-to-End MCP Protocol Client Tests
  // ==========================================================================
  describe('End-to-End MCP Client Transport', () => {
    it('registers all 7 tools on McpServer and serves calls via JSON-RPC', async () => {
      const { server } = createMcpServer({ registry, storage });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      const client = new Client(
        { name: 'test-qa-agent', version: '1.0.0' },
        { capabilities: {} }
      );

      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);

      // 1. List tools
      const toolsResponse = await client.listTools();
      const toolNames = toolsResponse.tools.map((t) => t.name);

      expect(toolNames).toContain(TOOL_NAMES.DISCOVER_CAPABILITIES);
      expect(toolNames).toContain(TOOL_NAMES.INSPECT_TARGET);
      expect(toolNames).toContain(TOOL_NAMES.CREATE_PLAN);
      expect(toolNames).toContain(TOOL_NAMES.EXECUTE_TEST);
      expect(toolNames).toContain(TOOL_NAMES.GET_EVIDENCE);
      expect(toolNames).toContain(TOOL_NAMES.GENERATE_REPORT);
      expect(toolNames).toContain(TOOL_NAMES.VERIFY_FIX);
      expect(toolsResponse.tools.length).toBe(7);

      // 2. Call qa_discover_capabilities via MCP Client
      const discoverRes: any = await client.callTool({
        name: TOOL_NAMES.DISCOVER_CAPABILITIES,
        arguments: { platform: 'web' },
      });
      expect(discoverRes.isError).toBeFalsy();
      const discoverText = discoverRes.content[0].text;
      const parsedDiscover = JSON.parse(discoverText);
      expect(parsedDiscover.capabilities).toBeDefined();

      // 3. Call qa_create_plan via MCP Client
      const createPlanRes: any = await client.callTool({
        name: TOOL_NAMES.CREATE_PLAN,
        arguments: {
          action: 'generate',
          targetApp: 'https://example.com',
          planType: 'smoke',
        },
      });
      expect(createPlanRes.isError).toBeFalsy();
      const planData = JSON.parse(createPlanRes.content[0].text);
      expect(planData.valid).toBe(true);

      // 4. Call qa_execute_test via MCP Client
      const execRes: any = await client.callTool({
        name: TOOL_NAMES.EXECUTE_TEST,
        arguments: {
          plan: planData.plan,
        },
      });
      expect(execRes.isError).toBeFalsy();
      const execData = JSON.parse(execRes.content[0].text);
      expect(execData.overallStatus).toBe('PASSED');

      // 5. Call qa_generate_report via MCP Client
      const reportRes: any = await client.callTool({
        name: TOOL_NAMES.GENERATE_REPORT,
        arguments: {
          runId: execData.runId,
          format: 'markdown',
        },
      });
      expect(reportRes.isError).toBeFalsy();
      expect(reportRes.content[0].text).toContain('QA Run Report:');

      await client.close();
      await server.close();
    });

    it('enforces bounded output limits when output exceeds max chars', async () => {
      // Create server with low maxOutputChars = 200
      const { server } = createMcpServer({
        registry,
        storage,
        maxOutputChars: 200,
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client(
        { name: 'test-qa-agent', version: '1.0.0' },
        { capabilities: {} }
      );

      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);

      const res: any = await client.callTool({
        name: TOOL_NAMES.DISCOVER_CAPABILITIES,
        arguments: {},
      });

      expect(res.content[0].text).toContain('[Output truncated from');

      await client.close();
      await server.close();
    });
  });
});
