import { Command } from 'commander';
import { CapabilityRegistry } from '@agentic-qa/core';
import { EnvDetector, DefaultEnvDetector } from './utils/env.js';
import { createDefaultRegistry } from './utils/registry.js';
import { createLogger, CliLogger } from './output.js';

import { registerDoctorCommand } from './commands/doctor.js';
import { registerInitCommand } from './commands/init.js';
import { registerCapabilitiesCommand } from './commands/capabilities.js';
import { registerInspectCommand } from './commands/inspect.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerTestCommand } from './commands/test.js';
import { registerExploreCommand } from './commands/explore.js';
import { registerVisualCommand } from './commands/visual.js';
import { registerReportCommand } from './commands/report.js';
import { registerVerifyFixCommand } from './commands/verify-fix.js';

export interface CliDependencies {
  envDetector?: EnvDetector;
  registryFactory?: () => CapabilityRegistry;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  exitOverride?: boolean;
}

export function createCli(deps: CliDependencies = {}): Command {
  const envDetector = deps.envDetector || new DefaultEnvDetector();
  const registryFactory = deps.registryFactory || createDefaultRegistry;

  const getLogger = (isJson: boolean): CliLogger => {
    return createLogger(isJson, deps.stdout, deps.stderr);
  };

  const program = new Command();

  program
    .name('qa')
    .description('Universal Agentic QA Automation Engine CLI')
    .version('0.1.0');

  if (deps.exitOverride) {
    program.exitOverride();
  }

  // Register all 10 commands
  registerDoctorCommand(program, envDetector, registryFactory, getLogger);
  registerInitCommand(program, getLogger);
  registerCapabilitiesCommand(program, registryFactory, getLogger);
  registerInspectCommand(program, getLogger);
  registerPlanCommand(program, getLogger);
  registerTestCommand(program, registryFactory, getLogger);
  registerExploreCommand(program, registryFactory, getLogger);
  registerVisualCommand(program, registryFactory, getLogger);
  registerReportCommand(program, getLogger);
  registerVerifyFixCommand(program, registryFactory, getLogger);

  return program;
}

export async function runCli(args: string[] = process.argv, deps: CliDependencies = {}): Promise<number> {
  const program = createCli(deps);
  try {
    await program.parseAsync(args);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (err: any) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      return 0;
    }
    if (deps.stderr) {
      deps.stderr(err.message);
    } else {
      console.error(err.message);
    }
    return typeof process.exitCode === 'number' && process.exitCode !== 0 ? process.exitCode : 1;
  }
}
