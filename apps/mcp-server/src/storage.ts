import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  QARunReport,
  QARunReportSchema,
  EvidenceArtifact,
  Finding,
  TestPlan,
} from '@agentic-qa/schemas';

export class RunStorage {
  private reports: Map<string, QARunReport> = new Map();
  private findings: Map<string, Finding> = new Map();
  private evidence: Map<string, EvidenceArtifact> = new Map();
  private plans: Map<string, TestPlan> = new Map();
  private latestRunId: string | null = null;

  constructor(
    private readonly baseOutputDir: string = '.qa-output',
    autoLoadFromDisk: boolean = false
  ) {
    this.ensureDirs();
    if (autoLoadFromDisk) {
      this.loadFromDisk();
    }
  }

  private ensureDirs(): void {
    try {
      const reportsDir = path.resolve(process.cwd(), this.baseOutputDir, 'reports');
      fs.mkdirSync(reportsDir, { recursive: true });
    } catch {
      // Ignore directory creation error
    }
  }

  loadFromDisk(): void {
    try {
      const reportsDir = path.resolve(process.cwd(), this.baseOutputDir, 'reports');
      if (!fs.existsSync(reportsDir)) return;

      const files = fs.readdirSync(reportsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const filePath = path.join(reportsDir, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(content);
            const validated = QARunReportSchema.safeParse(parsed);
            if (validated.success) {
              const rep = validated.data;
              this.reports.set(rep.runId, rep);
              this.latestRunId = rep.runId;
              for (const finding of rep.findings) {
                this.findings.set(finding.id, finding);
              }
              for (const ev of rep.evidence) {
                this.evidence.set(ev.id, ev);
              }
            }
          } catch {
            // Ignore individual corrupted file
          }
        }
      }
    } catch {
      // Ignore disk load error
    }
  }

  // --------------------------------------------------------------------------
  // Reports
  // --------------------------------------------------------------------------

  saveReport(report: QARunReport): void {
    this.reports.set(report.runId, report);
    this.latestRunId = report.runId;

    // Index findings
    for (const finding of report.findings) {
      this.findings.set(finding.id, finding);
    }

    // Index evidence
    for (const ev of report.evidence) {
      this.evidence.set(ev.id, ev);
    }

    // Persist to disk
    try {
      this.ensureDirs();
      const reportsDir = path.resolve(process.cwd(), this.baseOutputDir, 'reports');
      const filePath = path.join(reportsDir, `${report.runId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
    } catch (err: any) {
      // Non-fatal logging for storage write issues
    }
  }

  getReport(runId?: string): QARunReport | undefined {
    if (runId) {
      return this.reports.get(runId);
    }
    if (this.latestRunId) {
      return this.reports.get(this.latestRunId);
    }
    return undefined;
  }

  getAllReports(): QARunReport[] {
    return Array.from(this.reports.values());
  }

  getLatestRunId(): string | null {
    return this.latestRunId;
  }

  // --------------------------------------------------------------------------
  // Findings
  // --------------------------------------------------------------------------

  saveFinding(finding: Finding): void {
    this.findings.set(finding.id, finding);
  }

  getFinding(findingId: string): Finding | undefined {
    return this.findings.get(findingId);
  }

  updateFinding(
    findingId: string,
    updates: Partial<Pick<Finding, 'status' | 'fixVerification' | 'verifiedAt' | 'metadata'>>
  ): Finding | undefined {
    const finding = this.findings.get(findingId);
    if (!finding) return undefined;

    const updated: Finding = {
      ...finding,
      ...updates,
      metadata: {
        ...finding.metadata,
        ...(updates.metadata || {}),
      },
    };
    this.findings.set(findingId, updated);

    // Also update in any report containing it and persist
    for (const report of this.reports.values()) {
      const idx = report.findings.findIndex((f) => f.id === findingId);
      if (idx !== -1) {
        report.findings[idx] = updated;
        try {
          const reportsDir = path.resolve(process.cwd(), this.baseOutputDir, 'reports');
          const filePath = path.join(reportsDir, `${report.runId}.json`);
          fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
        } catch {
          // Ignore write error
        }
      }
    }

    return updated;
  }

  getAllFindings(): Finding[] {
    return Array.from(this.findings.values());
  }

  // --------------------------------------------------------------------------
  // Evidence
  // --------------------------------------------------------------------------

  saveEvidence(artifact: EvidenceArtifact): void {
    this.evidence.set(artifact.id, artifact);
  }

  getEvidence(evidenceId: string): EvidenceArtifact | undefined {
    return this.evidence.get(evidenceId);
  }

  async readEvidenceContent(
    evidenceId: string,
    options: {
      encoding?: 'base64' | 'utf8' | 'metadata_only';
      maxBytes?: number;
    } = {}
  ): Promise<{
    artifact: EvidenceArtifact;
    verifiedChecksum: boolean;
    actualSha256?: string;
    data?: string;
    truncated: boolean;
  }> {
    const artifact = this.evidence.get(evidenceId);
    if (!artifact) {
      throw new Error(`Evidence artifact '${evidenceId}' not found in storage.`);
    }

    if (options.encoding === 'metadata_only') {
      return {
        artifact,
        verifiedChecksum: true,
        actualSha256: artifact.sha256,
        truncated: false,
      };
    }

    const maxBytes = options.maxBytes ?? 500000;
    const resolvedPath = path.isAbsolute(artifact.path)
      ? artifact.path
      : path.resolve(process.cwd(), artifact.path);

    if (!fs.existsSync(resolvedPath)) {
      if (artifact.metadata?.rawContent) {
        const raw = Buffer.from(String(artifact.metadata.rawContent));
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const truncated = raw.length > maxBytes;
        const slice = raw.subarray(0, maxBytes);
        return {
          artifact,
          verifiedChecksum: hash === artifact.sha256,
          actualSha256: hash,
          data: options.encoding === 'base64' ? slice.toString('base64') : slice.toString('utf8'),
          truncated,
        };
      }
      throw new Error(`Evidence file does not exist at path: ${resolvedPath}`);
    }

    const stat = fs.statSync(resolvedPath);
    const fullBuffer = fs.readFileSync(resolvedPath);
    const actualSha256 = crypto.createHash('sha256').update(fullBuffer).digest('hex');
    const verifiedChecksum = actualSha256 === artifact.sha256;

    const truncated = stat.size > maxBytes;
    const slice = fullBuffer.subarray(0, maxBytes);
    const data =
      options.encoding === 'base64'
        ? slice.toString('base64')
        : slice.toString('utf8');

    return {
      artifact,
      verifiedChecksum,
      actualSha256,
      data,
      truncated,
    };
  }

  // --------------------------------------------------------------------------
  // Plans
  // --------------------------------------------------------------------------

  savePlan(plan: TestPlan): void {
    this.plans.set(plan.planId, plan);
  }

  getPlan(planId: string): TestPlan | undefined {
    return this.plans.get(planId);
  }

  getAllPlans(): TestPlan[] {
    return Array.from(this.plans.values());
  }

  // --------------------------------------------------------------------------
  // Reset / Clear
  // --------------------------------------------------------------------------

  clear(): void {
    this.reports.clear();
    this.findings.clear();
    this.evidence.clear();
    this.plans.clear();
    this.latestRunId = null;
  }
}

let defaultStorageInstance: RunStorage | null = null;

export function getDefaultRunStorage(): RunStorage {
  if (!defaultStorageInstance) {
    defaultStorageInstance = new RunStorage('.qa-output', true);
  }
  return defaultStorageInstance;
}
