import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  QARunReport,
  Finding,
  TestCaseResult,
  EvidenceArtifact,
} from '@agentic-qa/schemas';
import { HtmlReportOptions } from './types.js';

export async function generateHtmlDashboard(
  report: QARunReport,
  options: HtmlReportOptions = {}
): Promise<string> {
  const embed = options.embedArtifacts ?? true;
  const title = options.title || `QA Test Report: ${report.projectName}`;
  const baseDir = options.evidenceBaseDir || '.';

  // Pre-load base64 images and log text if embedding
  const artifactDataMap = new Map<string, { base64?: string; text?: string }>();
  if (embed) {
    for (const art of report.evidence) {
      try {
        const filePath = path.isAbsolute(art.path) ? art.path : path.resolve(baseDir, art.path);
        const buffer = await fs.readFile(filePath);
        if (art.type === 'SCREENSHOT' || art.type === 'PERCEPTUAL_DIFF') {
          artifactDataMap.set(art.id, {
            base64: `data:${art.mimeType};base64,${buffer.toString('base64')}`,
          });
        } else if (art.type === 'CONSOLE_LOG' || art.type === 'SYSTEM_LOG' || art.type === 'DOM_SNAPSHOT') {
          artifactDataMap.set(art.id, {
            text: buffer.toString('utf-8'),
          });
        }
      } catch {
        // Artifact file may not be on disk; fallback gracefully
      }
    }
  }

  const statusColor = getStatusColor(report.overallStatus);
  const trustColor = getTrustColor(report.trustScore.score);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --card-border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --success: #22c55e;
      --danger: #ef4444;
      --warning: #f59e0b;
      --info: #3b82f6;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font);
      line-height: 1.5;
      padding: 24px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .header-info h1 { font-size: 24px; font-weight: 700; margin-bottom: 6px; }
    .header-meta { color: var(--text-muted); font-size: 14px; display: flex; gap: 16px; flex-wrap: wrap; }
    .status-badge {
      font-size: 14px;
      font-weight: 700;
      padding: 6px 16px;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: ${statusColor}22;
      color: ${statusColor};
      border: 1px solid ${statusColor};
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 16px;
      text-align: center;
    }
    .metric-card .value { font-size: 32px; font-weight: 700; margin: 4px 0; }
    .metric-card .label { color: var(--text-muted); font-size: 13px; text-transform: uppercase; font-weight: 600; }
    .trust-card {
      background: linear-gradient(135deg, #1e293b, #0f172a);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .trust-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .trust-score-val { font-size: 36px; font-weight: 800; color: ${trustColor}; }
    .progress-bar {
      background: #334155;
      height: 10px;
      border-radius: 5px;
      overflow: hidden;
      margin-bottom: 16px;
    }
    .progress-fill {
      height: 100%;
      background: ${trustColor};
      width: ${report.trustScore.score}%;
      transition: width 0.3s ease;
    }
    .trust-breakdown-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 12px;
      font-size: 13px;
    }
    .trust-pill {
      background: rgba(255,255,255,0.05);
      padding: 10px;
      border-radius: 8px;
      border: 1px solid var(--card-border);
    }
    .trust-pill-label { color: var(--text-muted); font-size: 11px; text-transform: uppercase; }
    .trust-pill-value { font-size: 16px; font-weight: 600; margin-top: 2px; }
    .honesty-alert {
      background: #ef444422;
      border: 1px solid var(--danger);
      color: #fca5a5;
      padding: 12px 16px;
      border-radius: 8px;
      margin-top: 14px;
      font-size: 13px;
    }
    .section-title { font-size: 18px; font-weight: 700; margin: 32px 0 16px; display: flex; align-items: center; gap: 8px; }
    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 16px;
      align-items: center;
    }
    .filter-btn {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: all 0.2s;
    }
    .filter-btn:hover, .filter-btn.active {
      background: var(--accent);
      color: #0f172a;
      border-color: var(--accent);
    }
    .search-input {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 8px 14px;
      border-radius: 6px;
      font-size: 13px;
      margin-left: auto;
      min-width: 220px;
    }
    .search-input:focus { outline: 1px solid var(--accent); }
    .test-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      margin-bottom: 12px;
      overflow: hidden;
    }
    .test-header {
      padding: 14px 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
    }
    .test-header:hover { background: rgba(255,255,255,0.02); }
    .test-title-box { display: flex; align-items: center; gap: 12px; }
    .test-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .badge-passed { background: #22c55e22; color: #22c55e; border: 1px solid #22c55e; }
    .badge-failed { background: #ef444422; color: #ef4444; border: 1px solid #ef4444; }
    .badge-blocked { background: #f59e0b22; color: #f59e0b; border: 1px solid #f59e0b; }
    .badge-skipped { background: #94a3b822; color: #94a3b8; border: 1px solid #94a3b8; }
    .badge-error { background: #ef444422; color: #ef4444; border: 1px solid #ef4444; }
    .test-body {
      padding: 16px 18px;
      border-top: 1px solid var(--card-border);
      background: rgba(0,0,0,0.15);
      display: none;
    }
    .test-body.open { display: block; }
    .step-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .step-item {
      padding: 8px 12px;
      border-radius: 6px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
    }
    .step-error { color: #fca5a5; font-size: 12px; margin-top: 4px; font-family: monospace; }
    .finding-card {
      background: var(--card-bg);
      border-left: 4px solid var(--danger);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 14px;
      border-top: 1px solid var(--card-border);
      border-right: 1px solid var(--card-border);
      border-bottom: 1px solid var(--card-border);
    }
    .finding-card.severity-critical { border-left-color: #ef4444; }
    .finding-card.severity-high { border-left-color: #f97316; }
    .finding-card.severity-medium { border-left-color: #f59e0b; }
    .finding-card.severity-low { border-left-color: #3b82f6; }
    .finding-card.severity-info { border-left-color: #94a3b8; }
    .finding-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .repro-steps {
      background: #0f172a;
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 10px 14px;
      margin: 10px 0;
      font-size: 13px;
    }
    .repro-steps ol { margin-left: 18px; }
    .diff-box {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin: 10px 0;
      font-size: 12px;
    }
    .diff-col {
      background: #0f172a;
      padding: 10px;
      border-radius: 6px;
      border: 1px solid var(--card-border);
    }
    .diff-title { color: var(--text-muted); font-size: 11px; text-transform: uppercase; font-weight: 700; margin-bottom: 4px; }
    .gallery {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 12px;
    }
    .thumbnail {
      width: 140px;
      height: 90px;
      border-radius: 6px;
      border: 1px solid var(--card-border);
      object-fit: cover;
      cursor: pointer;
      transition: transform 0.2s;
    }
    .thumbnail:hover { transform: scale(1.04); border-color: var(--accent); }
    .log-viewer {
      background: #020617;
      color: #e2e8f0;
      padding: 14px;
      border-radius: 6px;
      font-family: monospace;
      font-size: 12px;
      max-height: 240px;
      overflow-y: auto;
      white-space: pre-wrap;
      border: 1px solid #1e293b;
      margin-top: 8px;
    }
    .evidence-table {
      width: 100%;
      border-collapse: collapse;
      background: var(--card-bg);
      border-radius: 8px;
      overflow: hidden;
      font-size: 13px;
    }
    .evidence-table th, .evidence-table td {
      padding: 10px 14px;
      text-align: left;
      border-bottom: 1px solid var(--card-border);
    }
    .evidence-table th { background: rgba(0,0,0,0.2); color: var(--text-muted); font-weight: 600; }
    .sha-badge {
      font-family: monospace;
      font-size: 11px;
      background: #0f172a;
      padding: 3px 6px;
      border-radius: 4px;
      border: 1px solid var(--card-border);
    }
    /* Modal */
    .modal {
      display: none;
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.85);
      z-index: 1000;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .modal.active { display: flex; }
    .modal-content { max-width: 90%; max-height: 90%; border-radius: 8px; box-shadow: 0 0 24px rgba(0,0,0,0.8); }
    .modal-close {
      position: absolute;
      top: 20px; right: 24px;
      font-size: 32px;
      color: #fff;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="header-info">
        <h1>${escapeHtml(report.projectName)}</h1>
        <div class="header-meta">
          <span>Target: <strong>${escapeHtml(report.targetApp)}</strong></span>
          <span>Platform: <strong>${report.platform}</strong></span>
          <span>Run ID: <strong>${escapeHtml(report.runId)}</strong></span>
          <span>Duration: <strong>${(report.durationMs / 1000).toFixed(2)}s</strong></span>
        </div>
      </div>
      <div>
        <span class="status-badge">${report.overallStatus}</span>
      </div>
    </header>

    <!-- Metrics Cards -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="label">Total Tests</div>
        <div class="value">${report.summary.totalTests}</div>
      </div>
      <div class="metric-card">
        <div class="label" style="color: var(--success);">Passed</div>
        <div class="value" style="color: var(--success);">${report.summary.passed}</div>
      </div>
      <div class="metric-card">
        <div class="label" style="color: var(--danger);">Failed</div>
        <div class="value" style="color: var(--danger);">${report.summary.failed}</div>
      </div>
      <div class="metric-card">
        <div class="label" style="color: var(--warning);">Blocked / Skipped</div>
        <div class="value" style="color: var(--warning);">${report.summary.blocked + report.summary.skipped}</div>
      </div>
      <div class="metric-card">
        <div class="label" style="color: ${trustColor};">Trust Score</div>
        <div class="value" style="color: ${trustColor};">${report.trustScore.score}<span style="font-size: 16px;">/100</span></div>
      </div>
    </div>

    <!-- Trust Score Breakdown -->
    <div class="trust-card">
      <div class="trust-header">
        <div>
          <h2 style="font-size: 16px; font-weight: 700;">Trust & Integrity Verification</h2>
          <p style="color: var(--text-muted); font-size: 13px; margin-top: 2px;">
            ${escapeHtml(report.trustScore.summary)}
          </p>
        </div>
        <div class="trust-score-val">${report.trustScore.score}</div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill"></div>
      </div>
      <div class="trust-breakdown-grid">
        <div class="trust-pill">
          <div class="trust-pill-label">Deterministic Assertions</div>
          <div class="trust-pill-value">${report.trustScore.deterministicAssertionsCount} executed</div>
        </div>
        <div class="trust-pill">
          <div class="trust-pill-label">Evidence Artifacts</div>
          <div class="trust-pill-value">${report.trustScore.evidenceArtifactsCount} captured</div>
        </div>
        <div class="trust-pill">
          <div class="trust-pill-label">Reproducibility</div>
          <div class="trust-pill-value">${report.trustScore.reproducibilityScore}%</div>
        </div>
        <div class="trust-pill">
          <div class="trust-pill-label">Execution Coverage</div>
          <div class="trust-pill-value">${report.trustScore.coverageScore}%</div>
        </div>
        <div class="trust-pill">
          <div class="trust-pill-label">Honesty Penalty</div>
          <div class="trust-pill-value" style="color: ${report.trustScore.honestyPenalty > 0 ? 'var(--danger)' : 'var(--success)'};">
            -${report.trustScore.honestyPenalty} pts
          </div>
        </div>
      </div>
      ${report.trustScore.honestyPenalty > 0 ? `
      <div class="honesty-alert">
        <strong>⚠️ Honesty Penalty Notice:</strong> Execution incurred a deduction of -${report.trustScore.honestyPenalty} points. Assertions or findings were flagged as unverified, lacking concrete proof, or missing baseline baselines.
      </div>
      ` : ''}
    </div>

    <!-- Findings & Defects -->
    ${report.findings.length > 0 ? `
    <h2 class="section-title">Defects & Findings (${report.findings.length})</h2>
    <div>
      ${report.findings.map(finding => renderFindingCard(finding, artifactDataMap)).join('')}
    </div>
    ` : ''}

    <!-- Test Cases Section -->
    <h2 class="section-title">Test Results (${report.testResults.length})</h2>
    <div class="filter-bar">
      <button class="filter-btn active" onclick="filterTests('all')">All (${report.testResults.length})</button>
      <button class="filter-btn" onclick="filterTests('PASSED')">Passed (${report.summary.passed})</button>
      <button class="filter-btn" onclick="filterTests('FAILED')">Failed (${report.summary.failed})</button>
      <button class="filter-btn" onclick="filterTests('BLOCKED')">Blocked (${report.summary.blocked})</button>
      <button class="filter-btn" onclick="filterTests('SKIPPED')">Skipped (${report.summary.skipped})</button>
      <input type="text" id="testSearch" class="search-input" placeholder="Search tests..." oninput="searchTests()">
    </div>

    <div id="testList">
      ${report.testResults.map(test => renderTestCaseCard(test, artifactDataMap)).join('')}
    </div>

    <!-- Evidence Index -->
    <h2 class="section-title">Tamper-Evident Evidence Index (${report.evidence.length})</h2>
    <table class="evidence-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Type</th>
          <th>MIME</th>
          <th>Size</th>
          <th>SHA-256 Checksum</th>
          <th>Captured At</th>
        </tr>
      </thead>
      <tbody>
        ${report.evidence.map(art => `
        <tr>
          <td><strong>${escapeHtml(art.id)}</strong></td>
          <td>${art.type}</td>
          <td>${art.mimeType}</td>
          <td>${formatBytes(art.sizeBytes)}</td>
          <td><span class="sha-badge" title="${art.sha256}">${art.sha256.substring(0, 16)}...</span></td>
          <td>${escapeHtml(art.capturedAt)}</td>
        </tr>
        `).join('')}
      </tbody>
    </table>
  </div>

  <!-- Modal Viewer -->
  <div id="imageModal" class="modal" onclick="closeModal()">
    <span class="modal-close">&times;</span>
    <img id="modalImg" class="modal-content" src="" alt="Artifact Preview">
  </div>

  <script>
    function toggleAccordion(id) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('open');
    }

    function openModal(src) {
      const modal = document.getElementById('imageModal');
      const img = document.getElementById('modalImg');
      img.src = src;
      modal.classList.add('active');
    }

    function closeModal() {
      document.getElementById('imageModal').classList.remove('active');
    }

    function filterTests(status) {
      document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
      event.target.classList.add('active');
      const cards = document.querySelectorAll('.test-card');
      cards.forEach(card => {
        if (status === 'all' || card.getAttribute('data-status') === status) {
          card.style.display = 'block';
        } else {
          card.style.display = 'none';
        }
      });
    }

    function searchTests() {
      const query = document.getElementById('testSearch').value.toLowerCase();
      const cards = document.querySelectorAll('.test-card');
      cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(query) ? 'block' : 'none';
      });
    }
  </script>
</body>
</html>`;
}

function renderFindingCard(
  finding: Finding,
  artifactDataMap: Map<string, { base64?: string; text?: string }>
): string {
  const sevClass = `severity-${finding.severity.toLowerCase()}`;
  const screenshots = finding.evidenceIds
    .map((id) => ({ id, data: artifactDataMap.get(id) }))
    .filter((item) => item.data?.base64);

  return `
  <div class="finding-card ${sevClass}">
    <div class="finding-header">
      <div>
        <span class="test-badge badge-failed">${finding.severity}</span>
        <strong style="margin-left: 8px; font-size: 15px;">${escapeHtml(finding.title)}</strong>
        <span style="color: var(--text-muted); font-size: 12px; margin-left: 8px;">ID: ${escapeHtml(finding.id)}</span>
      </div>
      <div>
        <span class="test-badge badge-blocked">${finding.status}</span>
      </div>
    </div>
    <p style="font-size: 13px; color: #cbd5e1; margin-bottom: 8px;">${escapeHtml(finding.description)}</p>

    ${finding.reproductionSteps && finding.reproductionSteps.length > 0 ? `
    <div class="repro-steps">
      <div style="font-weight: 700; font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 4px;">Reproduction Steps</div>
      <ol>
        ${finding.reproductionSteps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}
      </ol>
    </div>
    ` : ''}

    <div class="diff-box">
      <div class="diff-col">
        <div class="diff-title">Expected Behavior</div>
        <code>${escapeHtml(finding.expectedBehavior)}</code>
      </div>
      <div class="diff-col">
        <div class="diff-title">Actual Behavior</div>
        <code style="color: #fca5a5;">${escapeHtml(finding.actualBehavior)}</code>
      </div>
    </div>

    ${screenshots.length > 0 ? `
    <div style="font-size: 12px; color: var(--text-muted); margin-top: 10px; font-weight: 600;">Captured Visual Evidence:</div>
    <div class="gallery">
      ${screenshots.map(s => `
        <img class="thumbnail" src="${s.data!.base64}" alt="Screenshot" onclick="openModal('${s.data!.base64}')" title="Click to enlarge">
      `).join('')}
    </div>
    ` : ''}

    ${finding.logsExcerpt ? `
    <div style="font-size: 12px; color: var(--text-muted); margin-top: 10px; font-weight: 600;">Log Excerpt:</div>
    <div class="log-viewer">${escapeHtml(finding.logsExcerpt)}</div>
    ` : ''}
  </div>`;
}

function renderTestCaseCard(
  test: TestCaseResult,
  artifactDataMap: Map<string, { base64?: string; text?: string }>
): string {
  const badgeClass = `badge-${test.status.toLowerCase()}`;
  const bodyId = `test-body-${test.testCaseId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  return `
  <div class="test-card" data-status="${test.status}">
    <div class="test-header" onclick="toggleAccordion('${bodyId}')">
      <div class="test-title-box">
        <span class="test-badge ${badgeClass}">${test.status}</span>
        <strong>${escapeHtml(test.title)}</strong>
        <span style="color: var(--text-muted); font-size: 12px;">(${escapeHtml(test.testCaseId)})</span>
      </div>
      <div style="color: var(--text-muted); font-size: 13px;">
        <span>${test.durationMs}ms</span> &bull; <span>${test.stepResults.length} step(s)</span>
      </div>
    </div>
    <div id="${bodyId}" class="test-body">
      ${test.error ? `<div class="step-error" style="margin-bottom: 12px;">Error: ${escapeHtml(test.error)}</div>` : ''}
      <ul class="step-list">
        ${test.stepResults.map(step => `
        <li class="step-item">
          <div>
            <span>${escapeHtml(step.stepId)}</span>
            ${step.error ? `<div class="step-error">${escapeHtml(step.error)}</div>` : ''}
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <span style="color: var(--text-muted); font-size: 11px;">${step.durationMs}ms</span>
            <span class="test-badge badge-${step.status.toLowerCase()}">${step.status}</span>
          </div>
        </li>
        `).join('')}
      </ul>
    </div>
  </div>`;
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'PASSED': return '#22c55e';
    case 'FAILED': return '#ef4444';
    case 'BLOCKED': return '#f59e0b';
    case 'PARTIAL': return '#3b82f6';
    default: return '#94a3b8';
  }
}

function getTrustColor(score: number): string {
  if (score >= 85) return '#22c55e';
  if (score >= 65) return '#38bdf8';
  if (score >= 45) return '#f59e0b';
  return '#ef4444';
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
