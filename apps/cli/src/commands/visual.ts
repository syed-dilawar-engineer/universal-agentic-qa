import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  RunLifecycle,
  CapabilityRegistry,
  QABlockedError,
  QAUnsupportedError,
} from '@agentic-qa/core';
import {
  TestPlan,
  TestPlanSchema,
  TestCase,
  Finding,
  EvidenceArtifact,
  Platform,
} from '@agentic-qa/schemas';
import { loadConfig } from '@agentic-qa/core';
import { createDefaultRegistry } from '../utils/registry.js';
import { saveReport, renderReportTerminal } from '../utils/reporter.js';
import { CliLogger, createTable, pc } from '../output.js';
import { VisualDiffEngine } from '@agentic-qa/engine-visual';

export interface VisualOptions {
  target?: string;
  baselineDir?: string;
  threshold?: string | number;
  updateBaselines?: boolean;
  viewports?: string;
  platform?: Platform;
  config?: string;
  out?: string;
  json?: boolean;
}

export function registerVisualCommand(
  program: Command,
  registryFactory: () => CapabilityRegistry = createDefaultRegistry,
  getLogger: (isJson: boolean) => CliLogger
): void {
  program
    .command('visual [target]')
    .description('Run visual regression check against baselines')
    .option('-t, --target <target>', 'Target URL or application path')
    .option('-b, --baseline-dir <path>', 'Directory containing baseline screenshots', '.qa-output/baselines')
    .option('--threshold <number>', 'Visual difference tolerance threshold (0.00 to 1.00)', '0.01')
    .option('-u, --update-baselines', 'Update/record baseline screenshots with current run')
    .option('--viewports <names>', 'Comma-separated viewport names (e.g. desktop,mobile-md)')
    .option('--platform <platform>', 'Target platform', 'web')
    .option('-c, --config <path>', 'Configuration file path')
    .option('-o, --out <path>', 'Destination path for run report JSON')
    .option('--json', 'Output machine-readable JSON')
    .action(async (targetArg: string | undefined, options: VisualOptions) => {
      const logger = getLogger(!!options.json);

      let target = targetArg || options.target;
      let platform = options.platform || 'web';
      let threshold = Number(options.threshold) || 0.01;
      let baselineDir = path.resolve(process.cwd(), options.baselineDir || '.qa-output/baselines');

      if (!target) {
        try {
          const cfg = loadConfig(options.config);
          target = cfg.target.url || cfg.target.appPath || 'http://localhost:3000';
          platform = cfg.target.platform || platform;
          threshold = cfg.visual?.diffThreshold ?? threshold;
        } catch {
          target = 'http://localhost:3000';
        }
      }

      if (!fs.existsSync(baselineDir)) {
        fs.mkdirSync(baselineDir, { recursive: true });
      }

      try {
        const registry = registryFactory();
        const capabilities = await registry.probeAllCapabilities();
        const adapter = await registry.resolveAdapterForTarget(platform);

        const viewportsList = (options.viewports ? options.viewports.split(',') : ['desktop', 'mobile-md']).map(v => v.trim());

        const scenarios: TestCase[] = viewportsList.map((vp, idx) => ({
          id: `visual-${vp}-${idx + 1}`,
          title: `Visual Regression Check - Viewport: ${vp}`,
          description: `Captures screenshot and compares against baseline ${vp}.png at threshold ${threshold}`,
          platform,
          timeoutMs: 30000,
          retries: 0,
          tags: ['visual', 'regression', vp],
          expectedOutcome: 'PASS',
          steps: [
            {
              id: `nav-${vp}`,
              description: `Navigate to target ${target}`,
              action: {
                type: 'navigate',
                value: target,
                timeoutMs: 10000,
                metadata: { viewport: vp },
              },
              assertion: {
                type: 'status200',
                critical: true,
                metadata: {},
              },
              continueOnFailure: false,
            },
            {
              id: `snap-${vp}`,
              description: `Capture and evaluate visual snapshot for ${vp}`,
              action: {
                type: 'snapshot',
                timeoutMs: 10000,
                metadata: { viewport: vp },
              },
              assertion: {
                type: 'noVisualRegression',
                tolerance: threshold,
                critical: true,
                metadata: { viewport: vp, baselineDir },
              },
              continueOnFailure: false,
            },
          ],
        }));

        const plan: TestPlan = {
          planId: `visual-plan-${Date.now()}`,
          name: `Visual Regression Suite for ${target}`,
          targetApp: target,
          platform,
          environment: 'local',
          scenarios,
          createdAt: new Date().toISOString(),
          metadata: {
            baselineDir,
            threshold,
            updateBaselines: !!options.updateBaselines,
          },
        };

        if (!options.json) {
          logger.log(pc.bold('\n📸 Executing Visual Regression Verification'));
          logger.log(`Target:           ${pc.cyan(target)}`);
          logger.log(`Baseline Dir:     ${pc.cyan(baselineDir)}`);
          logger.log(`Diff Threshold:   ${pc.cyan(String(threshold))}`);
          logger.log(`Update Baselines: ${options.updateBaselines ? pc.green('TRUE') : 'FALSE'}`);
          logger.log(`Viewports:        ${viewportsList.join(', ')}\n`);
        }

        const lifecycle = new RunLifecycle(adapter, plan, capabilities);
        const report = await lifecycle.execute();

        const diffEngine = new VisualDiffEngine({ defaultDiffThreshold: threshold });

        // Ensure screenshot evidence exists for each viewport
        for (const vp of viewportsList) {
          const alreadyCaptured = report.evidence.some(
            (e) => e.type === 'SCREENSHOT' && (e.metadata?.viewport === vp || e.description?.includes(vp))
          );
          if (!alreadyCaptured) {
            try {
              const shot = await adapter.captureEvidence('SCREENSHOT', `Visual snapshot for ${vp}`);
              if (shot) {
                shot.metadata = { ...shot.metadata, viewport: vp };
                report.evidence.push(shot);
              }
            } catch {
              // Ignore if adapter does not support screenshot capture
            }
          }
        }

        // If update baselines requested, save real screenshots to baseline dir
        if (options.updateBaselines) {
          for (const vp of viewportsList) {
            const baselineFile = path.join(baselineDir, `${vp}.png`);
            const matchedArtifact = report.evidence.find(
              (e) => e.type === 'SCREENSHOT' && (e.metadata?.viewport === vp || e.description?.includes(vp))
            ) || report.evidence.find((e) => e.type === 'SCREENSHOT');

            if (matchedArtifact && fs.existsSync(matchedArtifact.path)) {
              fs.copyFileSync(matchedArtifact.path, baselineFile);
            } else {
              throw new Error(
                `Missing screenshot artifact for viewport '${vp}'. Expected screenshot file on disk, but found none (${matchedArtifact?.path || 'not captured'}). Cannot update baseline without actual screenshot.`
              );
            }
          }
          if (!options.json) {
            logger.log(pc.green(`✔ Baselines successfully updated in ${baselineDir}`));
          }
        } else {
          // Compare captured screenshots with baselines via VisualDiffEngine
          for (const vp of viewportsList) {
            const baselineFile = path.join(baselineDir, `${vp}.png`);
            const matchedArtifact = report.evidence.find(
              (e) => e.type === 'SCREENSHOT' && (e.metadata?.viewport === vp || e.description?.includes(vp))
            ) || report.evidence.find((e) => e.type === 'SCREENSHOT');

            if (matchedArtifact && fs.existsSync(matchedArtifact.path)) {
              const diffPath = path.join(baselineDir, `${vp}-diff.png`);
              const diffResult = await diffEngine.compareFiles(baselineFile, matchedArtifact.path, {
                diffThreshold: threshold,
                outputDiffPath: diffPath,
                platform,
              });

              if (!diffResult.passed) {
                report.overallStatus = 'FAILED';
                if (diffResult.finding) {
                  report.findings.push(diffResult.finding);
                }
                if (diffResult.evidenceArtifact) {
                  report.evidence.push(diffResult.evidenceArtifact);
                }
              }
            }
          }
        }

        const savedPath = saveReport(report, options.out);

        if (options.json) {
          logger.json({
            ...report,
            visualDetails: {
              baselineDir,
              threshold,
              viewportsTested: viewportsList,
              baselinesUpdated: !!options.updateBaselines,
            },
          });
        } else {
          renderReportTerminal(report, logger);
          logger.log(`\nReport artifact saved to: ${pc.cyan(savedPath)}`);
        }

        if (report.overallStatus === 'PASSED') {
          process.exitCode = 0;
        } else if (report.overallStatus === 'BLOCKED') {
          process.exitCode = 2;
        } else {
          process.exitCode = 1;
        }
      } catch (err: any) {
        if (err instanceof QABlockedError || err instanceof QAUnsupportedError) {
          if (options.json) {
            logger.json({ overallStatus: 'BLOCKED', error: err.message });
          } else {
            logger.error(`\n⚠ Visual check BLOCKED: ${err.message}`);
          }
          process.exitCode = 2;
        } else {
          if (options.json) {
            logger.json({ overallStatus: 'FAILED', error: err.message });
          } else {
            logger.error(`\n✖ Visual check failed: ${err.message}`);
          }
          process.exitCode = 1;
        }
      }
    });
}
