import { Command } from 'commander';
import { loadReport, renderReportTerminal, renderReportMarkdown } from '../utils/reporter.js';
import { CliLogger, pc } from '../output.js';

export interface ReportOptions {
  format?: 'table' | 'text' | 'markdown' | 'json';
  summary?: boolean;
  findingsOnly?: boolean;
  json?: boolean;
}

export function registerReportCommand(
  program: Command,
  getLogger: (isJson: boolean) => CliLogger
): void {
  program
    .command('report [reportPath]')
    .description('Format and view QA test findings and run reports')
    .option('-f, --format <format>', 'Report format (table, text, markdown, json)', 'table')
    .option('-s, --summary', 'Show high-level summary only')
    .option('--findings-only', 'Show detected findings and defects only')
    .option('--json', 'Output report as machine-readable JSON')
    .action(async (reportPathArg: string | undefined, options: ReportOptions) => {
      const isJson = options.json || options.format === 'json';
      const logger = getLogger(isJson);

      try {
        const report = loadReport(reportPathArg);

        if (isJson) {
          if (options.findingsOnly) {
            logger.json({
              runId: report.runId,
              count: report.findings.length,
              findings: report.findings,
            });
          } else if (options.summary) {
            logger.json({
              runId: report.runId,
              projectName: report.projectName,
              overallStatus: report.overallStatus,
              summary: report.summary,
              trustScore: report.trustScore,
            });
          } else {
            logger.json(report);
          }
          process.exitCode = 0;
          return;
        }

        if (options.format === 'markdown') {
          const md = renderReportMarkdown(report);
          logger.log(md);
          process.exitCode = 0;
          return;
        }

        renderReportTerminal(report, logger, {
          summaryOnly: !!options.summary,
          findingsOnly: !!options.findingsOnly,
        });

        process.exitCode = 0;
      } catch (err: any) {
        if (isJson) {
          logger.json({ success: false, error: err.message });
        } else {
          logger.error(`\n✖ Failed to load report: ${err.message}`);
        }
        process.exitCode = 1;
      }
    });
}
