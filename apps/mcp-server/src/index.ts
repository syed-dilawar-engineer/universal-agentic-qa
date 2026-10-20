#!/usr/bin/env node
import { runServerOverStdio } from './server.js';

export * from './types.js';
export * from './storage.js';
export * from './server.js';
export * from './tools/index.js';
export * from './adapters/index.js';

// Auto-start over stdio if executed as the main CLI entrypoint
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('agentic-qa-mcp') ||
  process.argv[1]?.endsWith('apps/mcp-server/dist/index.js') ||
  process.argv[1]?.endsWith('apps/mcp-server/src/index.ts');

if (isMain) {
  runServerOverStdio().catch((err) => {
    // Write fatal initialization errors to stderr (MCP uses stdout for JSON-RPC messages)
    process.stderr.write(`[agentic-qa-mcp] Fatal error starting server: ${err?.message || err}\n`);
    process.exit(1);
  });
}
