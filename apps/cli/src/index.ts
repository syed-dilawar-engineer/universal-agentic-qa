export * from './cli.js';
export * from './output.js';
export * from './utils/env.js';
export * from './utils/reporter.js';
export * from './utils/registry.js';
export * from './adapters/index.js';
export * from './commands/doctor.js';
export * from './commands/init.js';
export * from './commands/capabilities.js';
export * from './commands/inspect.js';
export * from './commands/plan.js';
export * from './commands/test.js';
export * from './commands/explore.js';
export * from './commands/visual.js';
export * from './commands/report.js';
export * from './commands/verify-fix.js';

import { runCli } from './cli.js';

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Auto-run if executed directly as entrypoint or via symlink/CLI wrapper
function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const invokedFile = fs.realpathSync(process.argv[1]);
    return (
      currentFile === invokedFile ||
      process.argv[1].endsWith('universal-agentic-qa') ||
      process.argv[1].endsWith('qa') ||
      process.argv[1].endsWith('index.js')
    );
  } catch {
    return true;
  }
}

if (isDirectExecution()) {
  runCli(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
