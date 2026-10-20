import { Command } from 'commander';
import { runFullDoctor, EnvDetector, DefaultEnvDetector } from '../utils/env.js';
import { CapabilityRegistry } from '@agentic-qa/core';
import { createDefaultRegistry } from '../utils/registry.js';
import { CliLogger, createTable, pc } from '../output.js';

export interface DoctorOptions {
  json?: boolean;
}

export function registerDoctorCommand(
  program: Command,
  envDetector: EnvDetector = new DefaultEnvDetector(),
  registryFactory: () => CapabilityRegistry = createDefaultRegistry,
  getLogger: (isJson: boolean) => CliLogger
): void {
  program
    .command('doctor')
    .description('Detect runtimes, browsers, mobile tools, and platform adapters')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: DoctorOptions) => {
      const logger = getLogger(!!options.json);
      const report = runFullDoctor(envDetector);
      const registry = registryFactory();
      const capabilities = await registry.probeAllCapabilities();

      const adapterChecks = capabilities.map(cap => ({
        name: `Adapter: ${cap.name} (${cap.platform})`,
        category: 'adapter' as const,
        status: (cap.state === 'AVAILABLE' ? 'ok' : cap.state === 'BLOCKED' ? 'missing' : 'warning') as any,
        version: cap.version,
        details: cap.reason || `State: ${cap.state}`,
      }));

      const allChecks = [...report.checks, ...adapterChecks];
      const hasCriticalError = allChecks.some(c => c.name === 'Node.js' && c.status !== 'ok');

      if (options.json) {
        logger.json({
          ok: !hasCriticalError,
          platform: report.platform,
          arch: report.arch,
          checks: allChecks,
          capabilities,
        });
        return;
      }

      logger.log(pc.bold('\n🔍 QA Engine Diagnostic Doctor\n'));
      logger.log(`Host Platform: ${pc.cyan(report.platform)} (${report.arch})`);
      logger.log(`Node Version:  ${pc.cyan(envDetector.getNodeVersion())}\n`);

      const table = createTable({
        head: ['Category', 'Component', 'Status', 'Details'].map(h => pc.bold(h)),
      });

      for (const check of allChecks) {
        let statusBadge = pc.green('✔ PASS');
        if (check.status === 'warning') statusBadge = pc.yellow('⚠ WARN');
        if (check.status === 'missing') statusBadge = pc.red('✖ MISS');
        if (check.status === 'unsupported') statusBadge = pc.gray('⊘ N/A');

        table.push([
          check.category.toUpperCase(),
          check.name + (check.version ? ` (${check.version})` : ''),
          statusBadge,
          check.details || '',
        ]);
      }

      logger.log(table.toString());

      if (hasCriticalError) {
        logger.error('\n✖ Doctor identified critical issues that prevent QA execution.');
        process.exitCode = 1;
      } else {
        logger.log('\n✔ Doctor diagnostics completed successfully.');
        process.exitCode = 0;
      }
    });
}
