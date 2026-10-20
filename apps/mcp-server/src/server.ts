import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CapabilityRegistry } from '@agentic-qa/core';
import {
  TOOL_NAMES,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_TOOL_TIMEOUT_MS,
  McpServerContext,
  DiscoverCapabilitiesInputShape,
  InspectTargetInputShape,
  CreatePlanInputShape,
  ExecuteTestInputShape,
  GetEvidenceInputShape,
  GenerateReportInputShape,
  VerifyFixInputShape,
} from './types.js';
import { RunStorage, getDefaultRunStorage } from './storage.js';
import {
  handleDiscoverCapabilities,
  handleInspectTarget,
  handleCreatePlan,
  handleExecuteTest,
  handleGetEvidence,
  handleGenerateReport,
  handleVerifyFix,
} from './tools/index.js';
import { HttpApiPlatformAdapter } from './adapters/http-api-adapter.js';

export interface CreateMcpServerOptions {
  name?: string;
  version?: string;
  registry?: CapabilityRegistry;
  storage?: RunStorage;
  maxOutputChars?: number;
}

export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  // Register built-in native HTTP adapter for API tests
  registry.registerAdapter(new HttpApiPlatformAdapter());
  return registry;
}

function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const truncated = text.substring(0, maxChars);
  return `${truncated}\n\n[Output truncated from ${text.length} down to ${maxChars} characters to avoid context overflow. Use qa_get_evidence or qa_generate_report for full artifact content.]`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Operation '${operationName}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createMcpServer(options: CreateMcpServerOptions = {}): {
  server: McpServer;
  context: McpServerContext;
} {
  const name = options.name ?? 'universal-agentic-qa';
  const version = options.version ?? '0.1.0';
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const registry = options.registry ?? createDefaultCapabilityRegistry();
  const storage = options.storage ?? getDefaultRunStorage();

  const context: McpServerContext = {
    registry,
    storage,
    maxOutputLength: maxOutputChars,
  };

  const server = new McpServer({
    name,
    version,
  });

  // --------------------------------------------------------------------------
  // Tool 1: qa_discover_capabilities
  // --------------------------------------------------------------------------
  server.tool(
    TOOL_NAMES.DISCOVER_CAPABILITIES,
    'Probes local environment, binaries, and platform drivers. Returns honest readiness states (AVAILABLE, UNAVAILABLE, UNSUPPORTED, BLOCKED) without false claims.',
    DiscoverCapabilitiesInputShape,
    async (args) => {
      try {
        const result = await withTimeout(
          handleDiscoverCapabilities(args as any, context),
          DEFAULT_TOOL_TIMEOUT_MS,
          TOOL_NAMES.DISCOVER_CAPABILITIES
        );
        const jsonText = JSON.stringify(result, null, 2);
        return {
          content: [{ type: 'text', text: truncateOutput(jsonText, maxOutputChars) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to discover capabilities: ${err.message}` }],
        };
      }
    }
  );

  // --------------------------------------------------------------------------
  // Tool 2: qa_inspect_target
  // --------------------------------------------------------------------------
  server.tool(
    TOOL_NAMES.INSPECT_TARGET,
    'Analyzes target web URL or local application file/folder path to detect reachability, technology stacks, headers, and QA test suitability.',
    InspectTargetInputShape,
    async (args) => {
      try {
        const timeout = (args.timeoutMs as number) || 10000;
        const result = await withTimeout(
          handleInspectTarget(args as any, context),
          timeout + 2000,
          TOOL_NAMES.INSPECT_TARGET
        );
        const jsonText = JSON.stringify(result, null, 2);
        return {
          content: [{ type: 'text', text: truncateOutput(jsonText, maxOutputChars) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to inspect target: ${err.message}` }],
        };
      }
    }
  );

  // --------------------------------------------------------------------------
  // Tool 3: qa_create_plan
  // --------------------------------------------------------------------------
  server.tool(
    TOOL_NAMES.CREATE_PLAN,
    "Generates or validates strictly-typed test plans against the Universal Agentic QA schema (smoke, accessibility, robustness, regression).",
    CreatePlanInputShape,
    async (args) => {
      try {
        const result = await withTimeout(
          handleCreatePlan(args as any, context),
          DEFAULT_TOOL_TIMEOUT_MS,
          TOOL_NAMES.CREATE_PLAN
        );
        const jsonText = JSON.stringify(result, null, 2);
        return {
          content: [{ type: 'text', text: truncateOutput(jsonText, maxOutputChars) }],
          isError: !result.valid,
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to create/validate plan: ${err.message}` }],
        };
      }
    }
  );

  // --------------------------------------------------------------------------
  // Tool 4: qa_execute_test
  // --------------------------------------------------------------------------
  server.tool(
    TOOL_NAMES.EXECUTE_TEST,
    'Executes approved test scenarios using RunLifecycle, deterministic assertions, and real-time evidence capture. Returns bounded results and trust scores.',
    ExecuteTestInputShape,
    async (args) => {
      try {
        const timeout = (args.timeoutMs as number) || 60000;
        const result = await withTimeout(
          handleExecuteTest(args as any, context),
          timeout + 5000,
          TOOL_NAMES.EXECUTE_TEST
        );
        const jsonText = JSON.stringify(result, null, 2);
        return {
          content: [{ type: 'text', text: truncateOutput(jsonText, maxOutputChars) }],
          isError: result.overallStatus === 'FAILED' || result.overallStatus === 'BLOCKED',
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Test execution failed: ${err.message}` }],
        };
      }
    }
  );

  // --------------------------------------------------------------------------
  // Tool 5: qa_get_evidence
  // --------------------------------------------------------------------------
  server.tool(
    TOOL_NAMES.GET_EVIDENCE,
    'Retrieves a specific evidence artifact (screenshot, DOM snapshot, HAR trace, log) by ID, with cryptographic sha256 checksum verification.',
    GetEvidenceInputShape,
    async (args) => {
      try {
        const result = await withTimeout(
          handleGetEvidence(args as any, context),
          DEFAULT_TOOL_TIMEOUT_MS,
          TOOL_NAMES.GET_EVIDENCE
        );
        const jsonText = JSON.stringify(result, null, 2);
        return {
          content: [{ type: 'text', text: truncateOutput(jsonText, maxOutputChars) }],
          isError: !result.found,
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to retrieve evidence: ${err.message}` }],
        };
      }
    }
  );

  // --------------------------------------------------------------------------
  // Tool 6: qa_generate_report
  // --------------------------------------------------------------------------
  server.tool(
    TOOL_NAMES.GENERATE_REPORT,
    'Generates a comprehensive markdown or JSON summary report of findings, defect severities, and the deterministic trust score for a QA run.',
    GenerateReportInputShape,
    async (args) => {
      try {
        const result = await withTimeout(
          handleGenerateReport(args as any, context),
          DEFAULT_TOOL_TIMEOUT_MS,
          TOOL_NAMES.GENERATE_REPORT
        );
        return {
          content: [{ type: 'text', text: truncateOutput(result.content, maxOutputChars) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to generate report: ${err.message}` }],
        };
      }
    }
  );

  // --------------------------------------------------------------------------
  // Tool 7: qa_verify_fix
  // --------------------------------------------------------------------------
  server.tool(
    TOOL_NAMES.VERIFY_FIX,
    'Reruns the regression scenario for a specific defect finding to truthfully confirm whether it has been resolved (FIX_VERIFIED) or persists (FIX_FAILED).',
    VerifyFixInputShape,
    async (args) => {
      try {
        const timeout = (args.timeoutMs as number) || 60000;
        const result = await withTimeout(
          handleVerifyFix(args as any, context),
          timeout + 5000,
          TOOL_NAMES.VERIFY_FIX
        );
        const jsonText = JSON.stringify(result, null, 2);
        return {
          content: [{ type: 'text', text: truncateOutput(jsonText, maxOutputChars) }],
          isError: !result.verified,
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to verify fix: ${err.message}` }],
        };
      }
    }
  );

  return { server, context };
}

export async function runServerOverStdio(): Promise<void> {
  const { server } = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
