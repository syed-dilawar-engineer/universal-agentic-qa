import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { QAConfig, QAConfigSchema, Platform } from '@agentic-qa/schemas';
import { CliLogger, pc } from '../output.js';

export interface InitOptions {
  path?: string;
  force?: boolean;
  platform?: Platform;
  url?: string;
  json?: boolean;
}

export function generateDefaultConfig(options: Partial<InitOptions> = {}): QAConfig {
  const platform = options.platform || 'web';
  const url = options.url || (platform === 'web' ? 'http://localhost:3000' : undefined);

  return QAConfigSchema.parse({
    name: 'agentic-qa-project',
    version: '1.0.0',
    target: {
      platform,
      url,
    },
    viewports: [
      { name: 'mobile-sm', width: 320, height: 568 },
      { name: 'mobile-md', width: 375, height: 667 },
      { name: 'mobile-lg', width: 390, height: 844 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'desktop', width: 1440, height: 900 },
    ],
    outputDir: '.qa-output',
    limits: {
      maxTestDurationMs: 120000,
      maxActionsPerTest: 1000,
      maxReproductionAttempts: 5,
    },
    visual: {
      diffThreshold: 0.01,
      updateBaselines: false,
    },
    accessibility: {
      enabled: true,
      standards: ['wcag2a', 'wcag2aa', 'wcag21aa'],
    },
    robustness: {
      rapidClickCount: 500,
      fuzzIterations: 50,
      randomSeed: 42,
    },
  });
}

export function registerInitCommand(
  program: Command,
  getLogger: (isJson: boolean) => CliLogger
): void {
  program
    .command('init')
    .description('Generate standard qa.config.json configuration template')
    .option('-p, --path <path>', 'Destination path for config file', 'qa.config.json')
    .option('-f, --force', 'Overwrite existing configuration file')
    .option('--platform <platform>', 'Default platform target (web, mobile, desktop, api, game)', 'web')
    .option('--url <url>', 'Target base URL for web testing')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: InitOptions) => {
      const logger = getLogger(!!options.json);
      const targetPath = path.resolve(process.cwd(), options.path || 'qa.config.json');

      if (fs.existsSync(targetPath) && !options.force) {
        if (options.json) {
          logger.json({
            success: false,
            error: `Configuration file already exists at ${targetPath}. Use --force to overwrite.`,
            path: targetPath,
          });
        } else {
          logger.error(`\n✖ Configuration file already exists at ${targetPath}. Use --force to overwrite.`);
        }
        process.exitCode = 1;
        return;
      }

      try {
        const config = generateDefaultConfig(options);
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(targetPath, JSON.stringify(config, null, 2), 'utf8');

        if (options.json) {
          logger.json({
            success: true,
            path: targetPath,
            config,
          });
        } else {
          logger.log(pc.bold('\n✔ Created QA configuration file successfully:'));
          logger.log(`  Path:     ${pc.cyan(targetPath)}`);
          logger.log(`  Platform: ${pc.cyan(config.target.platform)}`);
          if (config.target.url) {
            logger.log(`  Target:   ${pc.cyan(config.target.url)}`);
          }
          logger.log('\nYou can now run ' + pc.bold('qa doctor') + ' or ' + pc.bold('qa plan') + ' to proceed.');
        }
        process.exitCode = 0;
      } catch (err: any) {
        if (options.json) {
          logger.json({ success: false, error: err.message });
        } else {
          logger.error(`\n✖ Failed to generate configuration: ${err.message}`);
        }
        process.exitCode = 1;
      }
    });
}
