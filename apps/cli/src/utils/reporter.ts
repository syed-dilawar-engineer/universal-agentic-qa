import fs from 'node:fs';
import path from 'node:path';
import { QARunReport, QARunReportSchema } from '@agentic-qa/schemas';
import { CliLogger, createTable, pc } from '../output.js';

export function findLatestReport(outputDir: string = '.qa-output'): string | undefined {
  const dir = path.resolve(process.cwd(), outputDir);
  if (!fs.existsSync(dir)) return undefined;

  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('report-') && f.endsWith('.json'))
    .map(f => path.join(dir, f));

  if (files.length === 0) {
    const latest = path.join(dir, 'latest-report.json');
    if (fs.existsSync(latest)) return latest;
    return undefined;
  }

  // Sort by mtime descending
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

export function loadReport(reportPath?: string): QARunReport {
  const targetPath = reportPath || findLatestReport();
  if (!targetPath) {
    throw new Error('No QA report found. Run "qa test" first or specify a report file path.');
  }

  const resolved = path.resolve(process.cwd(), targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Report file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw);
  return QARunReportSchema.parse(parsed);
}

export function saveReport(report: QARunReport, customPath?: string): string {
  const outputDir = path.resolve(process.cwd(), '.qa-output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filePath = customPath
    ? path.resolve(process.cwd(), customPath)
    : path.join(outputDir, `report-${Date.now()}.json`);

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');

  // Also write/update latest-report.json
  const latestPath = path.join(outputDir, 'latest-report.json');
  try {
    fs.writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf8');
  } catch {
    // Ignore latest symlink/file overwrite error
  }

  return filePath;
}

export function renderReportTerminal(
  report: QARunReport,
  logger: CliLogger,
  options: { summaryOnly?: boolean; findingsOnly?: boolean } = {}
): void {
  const statusColor =
    report.overallStatus === 'PASSED'
      ? pc.green(report.overallStatus)
      : report.overallStatus === 'BLOCKED'
      ? pc.yellow(report.overallStatus)
      : pc.red(report.overallStatus);

  logger.log('\n' + pc.bold('================================================================================'));
  logger.log(pc.bold(` QA RUN REPORT: ${report.projectName}`) + `  [${statusColor}]`);
  logger.log(pc.bold('================================================================================'));
  logger.log(`Target:      ${pc.cyan(report.targetApp)} (${report.platform})`);
  logger.log(`Run ID:      ${report.runId}`);
  logger.log(`Duration:    ${report.durationMs}ms`);
  logger.log(`Finished:    ${report.finishedAt}`);

  // Summary Metrics Table
  const summaryTable = createTable({
    head: ['Total', 'Passed', 'Failed', 'Blocked', 'Skipped', 'Errors'].map(h => pc.bold(h)),
  });
  summaryTable.push([
    report.summary.totalTests,
    pc.green(String(report.summary.passed)),
    report.summary.failed > 0 ? pc.red(String(report.summary.failed)) : '0',
    report.summary.blocked > 0 ? pc.yellow(String(report.summary.blocked)) : '0',
    report.summary.skipped,
    report.summary.error > 0 ? pc.red(String(report.summary.error)) : '0',
  ]);
  logger.log('\n' + pc.bold('Execution Summary:'));
  logger.log(summaryTable.toString());

  // Trust Score Breakdown
  const trustColor =
    report.trustScore.score >= 80
      ? pc.green
      : report.trustScore.score >= 50
      ? pc.yellow
      : pc.red;

  logger.log('\n' + pc.bold('Trust & Verification Score: ') + trustColor(`${report.trustScore.score}/100`));
  logger.log(`  - Deterministic Assertions: ${report.trustScore.deterministicAssertionsCount}`);
  logger.log(`  - Evidence Artifacts:      ${report.trustScore.evidenceArtifactsCount}`);
  logger.log(`  - Reproducibility:          ${report.trustScore.reproducibilityScore}%`);
  logger.log(`  - Coverage:                 ${report.trustScore.coverageScore}%`);
  logger.log(`  - Summary:                  ${report.trustScore.summary}`);

  if (options.summaryOnly) return;

  // Test Results Table
  if (!options.findingsOnly && report.testResults.length > 0) {
    logger.log('\n' + pc.bold('Test Scenarios:'));
    const testTable = createTable({
      head: ['ID', 'Title', 'Status', 'Duration', 'Steps'].map(h => pc.bold(h)),
    });
    for (const tr of report.testResults) {
      const stColor =
        tr.status === 'PASSED'
          ? pc.green(tr.status)
          : tr.status === 'BLOCKED'
          ? pc.yellow(tr.status)
          : pc.red(tr.status);
      testTable.push([
        tr.testCaseId,
        tr.title,
        stColor,
        `${tr.durationMs}ms`,
        `${tr.stepResults.length} steps`,
      ]);
    }
    logger.log(testTable.toString());
  }

  // Findings Table
  logger.log('\n' + pc.bold(`Findings & Defects (${report.findings.length}):`));
  if (report.findings.length === 0) {
    logger.log(pc.green('  No defects or findings detected!'));
  } else {
    const findingTable = createTable({
      head: ['ID', 'Severity', 'Status', 'Title', 'Fix Status'].map(h => pc.bold(h)),
    });
    for (const f of report.findings) {
      const sevColor =
        f.severity === 'CRITICAL' || f.severity === 'HIGH'
          ? pc.red(f.severity)
          : f.severity === 'MEDIUM'
          ? pc.yellow(f.severity)
          : pc.blue(f.severity);

      findingTable.push([
        f.id,
        sevColor,
        f.status,
        f.title,
        f.fixVerification,
      ]);
    }
    logger.log(findingTable.toString());

    // Print detailed reproduction steps for findings
    for (const f of report.findings) {
      logger.log(`\n  ${pc.bold(f.id)}: ${pc.underline(f.title)}`);
      logger.log(`  Description: ${f.description}`);
      logger.log(`  Reproduction Steps:`);
      f.reproductionSteps.forEach((s, idx) => logger.log(`    ${idx + 1}. ${s}`));
      if (f.evidenceIds.length > 0) {
        logger.log(`  Evidence IDs: ${f.evidenceIds.join(', ')}`);
      }
    }
  }
}

export function renderReportMarkdown(report: QARunReport): string {
  let md = `# QA Run Report: ${report.projectName}\n\n`;
  md += `- **Overall Status**: ${report.overallStatus}\n`;
  md += `- **Target**: ${report.targetApp} (${report.platform})\n`;
  md += `- **Run ID**: \`${report.runId}\`\n`;
  md += `- **Duration**: ${report.durationMs}ms\n`;
  md += `- **Trust Score**: ${report.trustScore.score}/100\n\n`;

  md += `## Summary\n\n`;
  md += `| Total | Passed | Failed | Blocked | Skipped | Errors |\n`;
  md += `| --- | --- | --- | --- | --- | --- |\n`;
  md += `| ${report.summary.totalTests} | ${report.summary.passed} | ${report.summary.failed} | ${report.summary.blocked} | ${report.summary.skipped} | ${report.summary.error} |\n\n`;

  md += `## Findings (${report.findings.length})\n\n`;
  if (report.findings.length === 0) {
    md += `*No findings reported.*\n\n`;
  } else {
    for (const f of report.findings) {
      md += `### ${f.id}: ${f.title}\n`;
      md += `- **Severity**: ${f.severity}\n`;
      md += `- **Status**: ${f.status} (Fix: ${f.fixVerification})\n`;
      md += `- **Description**: ${f.description}\n`;
      md += `- **Reproduction Steps**:\n`;
      f.reproductionSteps.forEach(s => md += `  1. ${s}\n`);
      md += `\n`;
    }
  }

  return md;
}
