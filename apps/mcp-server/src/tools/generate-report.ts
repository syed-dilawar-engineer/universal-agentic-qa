import { QARunReport, QARunReportSchema, Finding } from '@agentic-qa/schemas';
import {
  GenerateReportInput,
  GenerateReportOutput,
  McpServerContext,
} from '../types.js';

export async function handleGenerateReport(
  input: GenerateReportInput,
  context: McpServerContext
): Promise<GenerateReportOutput> {
  const { runId, format = 'markdown', includeEvidence = true, maxFindings = 50 } = input;

  let report: QARunReport | undefined;

  if (input.report) {
    const parsed = QARunReportSchema.safeParse(input.report);
    if (!parsed.success) {
      throw new Error(`Invalid report object provided: ${parsed.error.message}`);
    }
    report = parsed.data;
  } else {
    report = context.storage.getReport(runId);
  }

  if (!report) {
    const errorMsg = runId
      ? `No QA run report found for run ID '${runId}'.`
      : 'No previous QA execution found in memory. Execute a test first using qa_execute_test.';
    throw new Error(errorMsg);
  }

  let content = '';

  if (format === 'json') {
    content = JSON.stringify(report, null, 2);
  } else if (format === 'summary') {
    content = formatSummary(report);
  } else {
    content = formatMarkdown(report, includeEvidence, maxFindings);
  }

  return {
    format,
    runId: report.runId,
    content,
    overallStatus: report.overallStatus,
    trustScore: report.trustScore.score,
  };
}

function formatSummary(report: QARunReport): string {
  const s = report.summary;
  return [
    `QA Execution Summary [Run: ${report.runId}]`,
    `Status: ${report.overallStatus}`,
    `Platform: ${report.platform} | Target: ${report.targetApp}`,
    `Tests: ${s.totalTests} total (${s.passed} passed, ${s.failed} failed, ${s.blocked} blocked, ${s.skipped} skipped)`,
    `Trust Score: ${report.trustScore.score}/100 (${report.trustScore.summary})`,
    `Findings: ${report.findings.length} detected`,
    `Evidence Artifacts: ${report.evidence.length} captured`,
    `Duration: ${report.durationMs}ms`,
  ].join('\n');
}

function formatMarkdown(
  report: QARunReport,
  includeEvidence: boolean,
  maxFindings: number
): string {
  const lines: string[] = [];

  // Header & Status
  const statusEmoji =
    report.overallStatus === 'PASSED'
      ? '✅ PASSED'
      : report.overallStatus === 'FAILED'
        ? '❌ FAILED'
        : '⚠️ BLOCKED';

  lines.push(`# QA Run Report: ${report.projectName}`);
  lines.push(`**Run ID:** \`${report.runId}\` | **Overall Status:** **${statusEmoji}**`);
  lines.push(`**Target Application:** \`${report.targetApp}\` | **Platform:** \`${report.platform}\``);
  lines.push(`**Started At:** ${report.startedAt} | **Duration:** ${report.durationMs}ms`);
  lines.push('');

  // Trust Score Breakdown
  const ts = report.trustScore;
  lines.push('## 🛡️ Truth & Trust Score Breakdown');
  lines.push(`- **Trust Score:** **${ts.score}/100**`);
  lines.push(`- **Deterministic Assertions Checked:** ${ts.deterministicAssertionsCount}`);
  lines.push(`- **Evidence Artifacts Captured:** ${ts.evidenceArtifactsCount}`);
  lines.push(`- **Reproducibility Rating:** ${ts.reproducibilityScore}%`);
  lines.push(`- **Honesty Penalty:** ${ts.honestyPenalty}`);
  lines.push(`> *${ts.summary}*`);
  lines.push('');

  // Test Results Summary
  const s = report.summary;
  lines.push('## 📊 Test Suite Execution Summary');
  lines.push(`| Total Scenarios | Passed | Failed | Blocked | Skipped | Error |`);
  lines.push(`| :---: | :---: | :---: | :---: | :---: | :---: |`);
  lines.push(`| **${s.totalTests}** | ${s.passed} | ${s.failed} | ${s.blocked} | ${s.skipped} | ${s.error} |`);
  lines.push('');

  // Scenario Details
  lines.push('### Scenario Details');
  for (const tc of report.testResults) {
    const tcEmoji = tc.status === 'PASSED' ? '✅' : '❌';
    lines.push(`#### ${tcEmoji} ${tc.title} (\`${tc.testCaseId}\`) - ${tc.durationMs}ms`);
    if (tc.error) {
      lines.push(`> **Error:** ${tc.error}`);
    }
    for (const step of tc.stepResults) {
      const stepEmoji = step.status === 'PASSED' ? '✓' : '✗';
      const errorText = step.error ? ` — *${step.error}*` : '';
      const evText = step.evidenceIds.length > 0 ? ` [Evidence: ${step.evidenceIds.join(', ')}]` : '';
      lines.push(`- ${stepEmoji} Step \`${step.stepId}\` (${step.durationMs}ms)${errorText}${evText}`);
    }
    lines.push('');
  }

  // Findings & Defects
  lines.push('## 🐞 Detected Defects & Findings');
  if (report.findings.length === 0) {
    lines.push('_No defects or assertion failures detected in this run._');
  } else {
    const displayed = report.findings.slice(0, maxFindings);
    for (const f of displayed) {
      const sevBadge = `[${f.severity}]`;
      lines.push(`### ${sevBadge} ${f.title} (\`${f.id}\`)`);
      lines.push(`- **Status:** \`${f.status}\` | **Fix Verification:** \`${f.fixVerification}\``);
      lines.push(`- **Description:** ${f.description}`);
      lines.push(`- **Expected Behavior:** \`${f.expectedBehavior}\``);
      lines.push(`- **Actual Behavior:** \`${f.actualBehavior}\``);
      lines.push(`- **Reproduction Steps:**`);
      for (const step of f.reproductionSteps) {
        lines.push(`  1. ${step}`);
      }
      if (f.evidenceIds.length > 0) {
        lines.push(`- **Associated Evidence IDs:** ${f.evidenceIds.map((id) => `\`${id}\``).join(', ')}`);
      }
      lines.push('');
    }

    if (report.findings.length > maxFindings) {
      lines.push(`_...and ${report.findings.length - maxFindings} more findings (capped by maxFindings)._`);
    }
  }
  lines.push('');

  // Evidence Index
  if (includeEvidence && report.evidence.length > 0) {
    lines.push('## 📁 Captured Evidence Artifacts');
    lines.push('| Evidence ID | Type | MIME Type | SHA-256 Checksum |');
    lines.push('| :--- | :--- | :--- | :--- |');
    for (const ev of report.evidence) {
      lines.push(`| \`${ev.id}\` | ${ev.type} | ${ev.mimeType} | \`${ev.sha256.substring(0, 16)}...\` |`);
    }
    lines.push('');
  }

  // Environment
  lines.push('## 🖥️ Environment & Host Information');
  lines.push(`- **OS / Platform:** \`${report.environmentInfo.platform || process.platform}\` (\`${report.environmentInfo.arch || process.arch}\`)`);
  lines.push(`- **Node.js:** \`${report.environmentInfo.nodeVersion || process.version}\``);

  return lines.join('\n');
}
