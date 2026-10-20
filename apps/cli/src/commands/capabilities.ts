import { Command } from 'commander';
import { CapabilityRegistry } from '@agentic-qa/core';
import { createDefaultRegistry } from '../utils/registry.js';
import { CliLogger, createTable, pc } from '../output.js';

export interface CapabilitiesOptions {
  json?: boolean;
}

export function registerCapabilitiesCommand(
  program: Command,
  registryFactory: () => CapabilityRegistry = createDefaultRegistry,
  getLogger: (isJson: boolean) => CliLogger
): void {
  program
    .command('capabilities')
    .description('Query all platform adapters and display probe capabilities')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: CapabilitiesOptions) => {
      const logger = getLogger(!!options.json);
      try {
        const registry = registryFactory();
        const capabilities = await registry.probeAllCapabilities();

        if (options.json) {
          logger.json({
            count: capabilities.length,
            capabilities,
          });
          process.exitCode = 0;
          return;
        }

        logger.log(pc.bold('\n🌐 QA Engine Platform Capabilities\n'));

        const table = createTable({
          head: ['Platform', 'Adapter', 'State', 'Required Tools', 'Missing Tools', 'Reason'].map(h => pc.bold(h)),
        });

        for (const cap of capabilities) {
          let stateBadge = pc.green(cap.state);
          if (cap.state === 'BLOCKED') stateBadge = pc.red(cap.state);
          if (cap.state === 'UNAVAILABLE') stateBadge = pc.yellow(cap.state);
          if (cap.state === 'UNSUPPORTED') stateBadge = pc.gray(cap.state);

          table.push([
            cap.platform.toUpperCase(),
            `${cap.name} (${cap.id})`,
            stateBadge,
            cap.requiredTools.join(', ') || '-',
            cap.missingTools.length > 0 ? pc.red(cap.missingTools.join(', ')) : '-',
            cap.reason || '-',
          ]);
        }

        logger.log(table.toString());
        logger.log(`\nTotal probed capabilities: ${pc.bold(String(capabilities.length))}`);
        process.exitCode = 0;
      } catch (err: any) {
        if (options.json) {
          logger.json({ success: false, error: err.message });
        } else {
          logger.error(`\n✖ Failed to probe capabilities: ${err.message}`);
        }
        process.exitCode = 1;
      }
    });
}
