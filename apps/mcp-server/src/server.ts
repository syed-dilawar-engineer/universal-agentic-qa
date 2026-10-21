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
import { WebAdapter } from '@agentic-qa/adapter-web';
import { MobileAdapter } from '@agentic-qa/adapter-mobile';
import { DesktopAdapter } from '@agentic-qa/adapter-desktop';

export interface CreateMcpServerOptions {
  name?: string;
  version?: string;
  registry?: CapabilityRegistry;
  storage?: RunStorage;
  maxOutputChars?: number;
}

export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  // Register full suite of real platform adapters
  registry.registerAdapter(new WebAdapter());
  registry.registerAdapter(new MobileAdapter());
  registry.registerAdapter(new DesktopAdapter());
  registry.registerAdapter(new HttpApiPlatformAdapter());
  return registry;
}

function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  // Try to parse structured JSON to avoid emitting syntax errors to LLM clients
  try {
    const parsed = JSON.parse(text);
    return pruneJsonOutput(parsed, text.length, maxChars);
  } catch {
    // For non-JSON (plain text, markdown), perform clean substring truncation
    const truncated = text.substring(0, maxChars);
    return `${truncated}\n\n[Output truncated from ${text.length} down to ${maxChars} characters to avoid context overflow. Use qa_get_evidence or qa_generate_report for full artifact content.]`;
  }
}

function pruneJsonOutput(data: any, originalLength: number, maxChars: number): string {
  const notice = `[Output truncated from ${originalLength} down to ${maxChars} characters to avoid context overflow. Use qa_get_evidence or qa_generate_report for full artifact content.]`;

  if (typeof data !== 'object' || data === null) {
    return JSON.stringify({
      _truncated: true,
      _warning: notice,
      value: String(data).slice(0, 100),
    });
  }

  const clone = JSON.parse(JSON.stringify(data));
  clone._truncation = notice;

  let serialized = JSON.stringify(clone, null, 2);
  if (serialized.length <= maxChars) {
    return serialized;
  }

  // Prune long strings inside top-level properties
  for (const key of Object.keys(clone)) {
    if (typeof clone[key] === 'string' && clone[key].length > 200 && key !== '_truncation') {
      clone[key] = clone[key].slice(0, 150) + '... [truncated]';
    }
  }

  serialized = JSON.stringify(clone, null, 2);
  if (serialized.length <= maxChars) {
    return serialized;
  }

  // Prune long arrays gracefully (e.g. findings, testResults, capabilities, trace, etc.)
  let anyArrayReduced = true;
  while (anyArrayReduced && JSON.stringify(clone, null, 2).length > maxChars) {
    anyArrayReduced = false;
    for (const key of Object.keys(clone)) {
      if (Array.isArray(clone[key]) && clone[key].length > 1) {
        const half = Math.max(1, Math.floor(clone[key].length / 2));
        clone[key] = clone[key].slice(0, half);
        anyArrayReduced = true;
      }
    }
  }

  serialized = JSON.stringify(clone, null, 2);
  if (serialized.length <= maxChars) {
    return serialized;
  }

  // Empty out arrays if still too large
  for (const key of Object.keys(clone)) {
    if (Array.isArray(clone[key])) {
      clone[`_${key}Count`] = clone[key].length;
      clone[key] = [];
    }
  }

  serialized = JSON.stringify(clone, null, 2);
  if (serialized.length <= maxChars) {
    return serialized;
  }

  // Fall back to minimal valid JSON representation within maxChars
  const minimal = {
    _truncated: true,
    _warning: notice,
  };
  const minIndented = JSON.stringify(minimal, null, 2);
  if (minIndented.length <= maxChars) {
    return minIndented;
  }

  const minCompact = JSON.stringify(minimal);
  if (minCompact.length <= maxChars) {
    return minCompact;
  }

  // In extreme cases where maxChars is tiny, ensure valid JSON with bounded notice
  const noticeBudget = Math.max(25, maxChars - 30);
  return JSON.stringify({
    _truncated: true,
    _warning: notice.slice(0, noticeBudget) + '...]',
  });
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
