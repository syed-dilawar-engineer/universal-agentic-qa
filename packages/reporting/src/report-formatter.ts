import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  QARunReport,
  QARunReportSchema,
  Finding,
  TestCaseResult,
  EvidenceArtifact,
} from '@agentic-qa/schemas';
import {
  MarkdownReportOptions,
  HtmlReportOptions,
} from './types.js';
import { generateHtmlDashboard } from './html-template.js';
import { formatTripartiteTitle } from './title-formatter.js';

export { formatTripartiteTitle };

export class ReportFormatter {
  // ==========================================================================
  // JSON REPORT
  // ==========================================================================

  /**
   * Serializes report to compliant JSON string, validating against QARunReportSchema
   */
  static formatJson(
    report: QARunReport,
    options: { pretty?: boolean; validate?: boolean } = {}
  ): string {
    const shouldValidate = options.validate ?? true;
    const pretty = options.pretty ?? true;

    if (shouldValidate) {
      QARunReportSchema.parse(report);
    }

    return JSON.stringify(report, null, pretty ? 2 : 0);
  }

  /**
   * Writes validated JSON report to file
   */
  static async writeJson(
    report: QARunReport,
    filePath: string,
    options: { pretty?: boolean; validate?: boolean } = {}
  ): Promise<void> {
    const json = ReportFormatter.formatJson(report, options);
    const resolvedPath = path.resolve(filePath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, json, 'utf-8');
  }

  /**
   * Reads and parses a JSON report from file, validating schema
   */
  static async readJson(
    filePath: string,
    options: { validate?: boolean } = {}
  ): Promise<QARunReport> {
    const resolvedPath = path.resolve(filePath);
    const raw = await fs.readFile(resolvedPath, 'utf-8');
    const data = JSON.parse(raw);
    const shouldValidate = options.validate ?? true;
    return shouldValidate ? QARunReportSchema.parse(data) : (data as QARunReport);
  }

  // ==========================================================================
  // MARKDOWN REPORT
  // ==========================================================================

  /**
   * Generates a comprehensive, clean GitHub-flavored Markdown report
   */
  static formatMarkdown(
    report: QARunReport,
    options: MarkdownReportOptions = {}
  ): string {
    const title = options.title || `QA Test Report: ${report.projectName}`;
    const includeLinks = options.includeEvidenceLinks ?? true;
    const includeLogs = options.includeLogSnippets ?? true;
    const baseUrl = options.evidenceBaseUrl || '';

    const statusBadge = getMarkdownStatusBadge(report.overallStatus);
    const trustBadge = getMarkdownTrustBadge(report.trustScore.score);
    const platformBadge = `![Platform](https://img.shields.io/badge/Platform-${encodeURIComponent(report.platform)}-informational)`;
    const testsBadge = `![Tests](https://img.shields.io/badge/Tests-${report.summary.passed}%2F${report.summary.totalTests}_passed-${report.summary.failed > 0 ? 'critical' : 'success'})`;

    const lines: string[] = [];

    // Header
    lines.push(`# ${title}`);
    lines.push('');
    lines.push(`${statusBadge} ${trustBadge} ${platformBadge} ${testsBadge}`);
    lines.push('');

    // Executive Summary
    lines.push('## Executive Summary');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('| :--- | :--- |');
    lines.push(`| **Target App** | \`${report.targetApp}\` |`);
    lines.push(`| **Platform** | \`${report.platform}\` |`);
    lines.push(`| **Overall Status** | **${report.overallStatus}** |`);
    lines.push(`| **Run ID** | \`${report.runId}\` |`);
    lines.push(`| **Started At** | ${report.startedAt} |`);
    lines.push(`| **Finished At** | ${report.finishedAt} |`);
    lines.push(`| **Total Duration** | ${(report.durationMs / 1000).toFixed(2)}s |`);
    lines.push(`| **Total Tests** | ${report.summary.totalTests} |`);
    lines.push(`| **Passed** | 🟢 ${report.summary.passed} |`);
    lines.push(`| **Failed** | 🔴 ${report.summary.failed} |`);
    lines.push(`| **Blocked / Skipped** | 🟡 ${report.summary.blocked + report.summary.skipped} |`);
    lines.push(`| **Trust Score** | **${report.trustScore.score} / 100** |`);
    lines.push('');

    // Trust Score Breakdown
    lines.push('## Trust & Integrity Score');
    lines.push('');
    lines.push(`> **${report.trustScore.score}/100** — ${report.trustScore.summary}`);
    lines.push('');
    lines.push('| Dimension | Value | Assessment |');
    lines.push('| :--- | :--- | :--- |');
    lines.push(`| **Deterministic Assertions** | ${report.trustScore.deterministicAssertionsCount} | Verifiable condition assertions executed |`);
    lines.push(`| **Evidence Artifacts** | ${report.trustScore.evidenceArtifactsCount} | Multimodal proof (screenshots, logs, diffs) |`);
    lines.push(`| **Reproducibility Rate** | ${report.trustScore.reproducibilityScore}% | Stability across runs & defect reproduction |`);
    lines.push(`| **Execution Coverage** | ${report.trustScore.coverageScore}% | Completed scenario coverage |`);
    lines.push(`| **Honesty Penalty** | ${report.trustScore.honestyPenalty > 0 ? `-${report.trustScore.honestyPenalty} pts` : '0 pts (Clean)'} | Penalties for unverified claims or missing baselines |`);
    lines.push('');

    // Test Results Breakdown Table
    lines.push('## Test Results Breakdown');
    lines.push('');
    lines.push('| # | Status | Test Case ID | Title | Duration | Steps | Attempts | Evidence |');
    lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');

    report.testResults.forEach((test, idx) => {
      const statusIcon = getStatusIcon(test.status);
      const evCount = test.evidenceIds ? test.evidenceIds.length : 0;
      const evCell = evCount > 0 ? `${evCount} artifact(s)` : '-';
      lines.push(
        `| ${idx + 1} | ${statusIcon} \`${test.status}\` | \`${test.testCaseId}\` | ${escapeMarkdown(test.title)} | ${test.durationMs}ms | ${test.stepResults.length} | ${test.attemptCount} | ${evCell} |`
      );
    });
    lines.push('');

    // Findings & Defects Section
    lines.push('## Detailed Findings & Defects');
    lines.push('');
    if (report.findings.length === 0) {
      lines.push('*No defects or issues detected during this run.*');
      lines.push('');
    } else {
      for (const finding of report.findings) {
        const sevIcon = getSeverityIcon(finding.severity);
        const formattedTitle = formatTripartiteTitle(finding);
        lines.push(`### ${sevIcon} [${finding.severity}] ${escapeMarkdown(formattedTitle)}`);
        lines.push('');
        lines.push(`- **Finding ID:** \`${finding.id}\``);
        lines.push(`- **Status:** \`${finding.status}\` | **Fix Verification:** \`${finding.fixVerification}\``);
        if (finding.testCaseId) {
          lines.push(`- **Associated Test:** \`${finding.testCaseId}\``);
        }
        lines.push(`- **Reproducibility:** ${Math.round(finding.reproducibilitySuccessRate * 100)}% (${finding.reproducibilityCount} attempts)`);
        lines.push(`- **Description:** ${escapeMarkdown(finding.description)}`);
        lines.push('');

        if (finding.rootCauseHypothesis) {
          lines.push('**Root Cause Hypothesis:**');
          lines.push(`- **Summary:** ${escapeMarkdown(finding.rootCauseHypothesis.summary)}`);
          if (finding.rootCauseHypothesis.suspectedComponent) {
            lines.push(`- **Suspected Component:** \`${escapeMarkdown(finding.rootCauseHypothesis.suspectedComponent)}\``);
          }
          if (finding.rootCauseHypothesis.theoreticalFlawType) {
            lines.push(`- **Theoretical Flaw Type:** \`${escapeMarkdown(finding.rootCauseHypothesis.theoreticalFlawType)}\``);
          }
          if (finding.rootCauseHypothesis.suggestedFix) {
            lines.push(`- **Suggested Fix:** ${escapeMarkdown(finding.rootCauseHypothesis.suggestedFix)}`);
          }
          lines.push('');
        }

        if (finding.preconditions && finding.preconditions.length > 0) {
          lines.push('**Preconditions:**');
          finding.preconditions.forEach((p) => lines.push(`- ${p}`));
          lines.push('');
        }

        if (finding.reproductionSteps && finding.reproductionSteps.length > 0) {
          lines.push('**Reproduction Steps:**');
          finding.reproductionSteps.forEach((step, stepIdx) => {
            lines.push(`${stepIdx + 1}. ${step}`);
          });
          lines.push('');
        }

        lines.push('**Behavior Comparison:**');
        lines.push(`- **Expected:** \`${finding.expectedBehavior}\``);
        lines.push(`- **Actual:** \`${finding.actualBehavior}\``);
        lines.push('');

        if (finding.evidenceIds && finding.evidenceIds.length > 0 && includeLinks) {
          lines.push('**Evidence Links:**');
          for (const evId of finding.evidenceIds) {
            const art = report.evidence.find((e) => e.id === evId);
            if (art) {
              const link = baseUrl ? `${baseUrl}/${path.basename(art.path)}` : art.path;
              lines.push(`- [${art.type}: ${art.id}](${link}) (${art.mimeType}, ${formatBytes(art.sizeBytes)})`);
            } else {
              lines.push(`- Artifact ID: \`${evId}\``);
            }
          }
          lines.push('');
        }

        if (finding.logsExcerpt && includeLogs) {
          lines.push('**Log Snippet:**');
          lines.push('```');
          lines.push(finding.logsExcerpt);
          lines.push('```');
          lines.push('');
        }
      }
    }

    // Evidence Index
    lines.push('## Tamper-Evident Evidence Catalog');
    lines.push('');
    if (report.evidence.length === 0) {
      lines.push('*No evidence artifacts recorded.*');
      lines.push('');
    } else {
      lines.push('| ID | Type | MIME | Size | SHA-256 Checksum | Link |');
      lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
      for (const art of report.evidence) {
        const link = baseUrl ? `${baseUrl}/${path.basename(art.path)}` : art.path;
        lines.push(
          `| \`${art.id}\` | ${art.type} | \`${art.mimeType}\` | ${formatBytes(art.sizeBytes)} | \`${art.sha256.substring(0, 16)}...\` | [View](${link}) |`
        );
      }
      lines.push('');
    }

    // Environment Information
    lines.push('## Environment Information');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(report.environmentInfo, null, 2));
    lines.push('```');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Writes Markdown report to file
   */
  static async writeMarkdown(
    report: QARunReport,
    filePath: string,
    options: MarkdownReportOptions = {}
  ): Promise<void> {
    const md = ReportFormatter.formatMarkdown(report, options);
    const resolvedPath = path.resolve(filePath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, md, 'utf-8');
  }

  // ==========================================================================
  // HTML REPORT
  // ==========================================================================

  /**
   * Generates interactive standalone HTML dashboard
   */
  static async formatHtml(
    report: QARunReport,
    options: HtmlReportOptions = {}
  ): Promise<string> {
    return generateHtmlDashboard(report, options);
  }

  /**
   * Writes standalone HTML dashboard to file
   */
  static async writeHtml(
    report: QARunReport,
    filePath: string,
    options: HtmlReportOptions = {}
  ): Promise<void> {
    const html = await ReportFormatter.formatHtml(report, options);
    const resolvedPath = path.resolve(filePath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, html, 'utf-8');
  }

  /**
   * Enforces and formats tripartite defect titles:
   * [Module/Feature] [Condition/Trigger] -> [Unexpected Behavior]
   */
  static formatTripartiteTitle(finding: Finding): string {
    return formatTripartiteTitle(finding);
  }
}

// Helpers
function getMarkdownStatusBadge(status: string): string {
  switch (status) {
    case 'PASSED':
      return '![Status](https://img.shields.io/badge/Status-PASSED-success)';
    case 'FAILED':
      return '![Status](https://img.shields.io/badge/Status-FAILED-critical)';
    case 'BLOCKED':
      return '![Status](https://img.shields.io/badge/Status-BLOCKED-important)';
    case 'PARTIAL':
      return '![Status](https://img.shields.io/badge/Status-PARTIAL-yellow)';
    default:
      return `![Status](https://img.shields.io/badge/Status-${status}-inactive)`;
  }
}

function getMarkdownTrustBadge(score: number): string {
  let color = 'critical';
  if (score >= 85) color = 'success';
  else if (score >= 65) color = 'informational';
  else if (score >= 45) color = 'yellow';

  return `![Trust Score](https://img.shields.io/badge/Trust_Score-${score}%2F100-${color})`;
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'PASSED': return '🟢';
    case 'FAILED': return '🔴';
    case 'BLOCKED': return '🟡';
    case 'SKIPPED': return '⚪';
    case 'ERROR': return '💥';
    default: return '❓';
  }
}

function getSeverityIcon(severity: string): string {
  switch (severity) {
    case 'CRITICAL': return '🔴';
    case 'HIGH': return '🟠';
    case 'MEDIUM': return '🟡';
    case 'LOW': return '🔵';
    case 'INFO': return '⚪';
    default: return '⚠️';
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
