import {
  TestPlan,
  TestCase,
  TestCaseResult,
  StepExecutionResult,
  Finding,
  EvidenceArtifact,
  QARunReport,
  CapabilityDescriptor,
  TrustScore,
} from '@agentic-qa/schemas';
import { PlatformAdapter } from './adapter.js';
import { QABlockedError, QATimeoutError } from './errors.js';

export interface ExecutionOptions {
  onStepStart?: (stepId: string, desc: string) => void;
  onStepEnd?: (stepResult: StepExecutionResult) => void;
  onTestCaseStart?: (testCase: TestCase) => void;
  onTestCaseEnd?: (result: TestCaseResult) => void;
  maxDurationMs?: number;
}

export class RunLifecycle {
  private startTime: number = 0;
  private endTime: number = 0;
  private evidenceStore: EvidenceArtifact[] = [];
  private findings: Finding[] = [];
  private testResults: TestCaseResult[] = [];

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly plan: TestPlan,
    private readonly capabilities: CapabilityDescriptor[]
  ) {}

  async execute(options: ExecutionOptions = {}): Promise<QARunReport> {
    this.startTime = Date.now();
    this.evidenceStore = [];
    this.findings = [];
    this.testResults = [];

    // Verify adapter capability first
    const capability = await this.adapter.getCapability();
    if (capability.state === 'BLOCKED' || capability.state === 'UNSUPPORTED') {
      throw new QABlockedError(
        `Execution blocked: adapter ${this.adapter.name} is ${capability.state}. ${capability.reason || ''}`,
        capability.missingTools.join(', ')
      );
    }

    try {
      await this.adapter.initialize();

      for (const testCase of this.plan.scenarios) {
        options.onTestCaseStart?.(testCase);
        const testCaseResult = await this.executeTestCase(testCase, options);
        this.testResults.push(testCaseResult);
        options.onTestCaseEnd?.(testCaseResult);
      }
    } finally {
      await this.adapter.teardown();
      this.endTime = Date.now();
    }

    return this.buildReport();
  }

  private async executeTestCase(
    testCase: TestCase,
    options: ExecutionOptions
  ): Promise<TestCaseResult> {
    const testCaseStart = Date.now();
    const stepResults: StepExecutionResult[] = [];
    let testStatus: 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED' | 'ERROR' = 'PASSED';
    let fatalError: string | undefined;

    for (const step of testCase.steps) {
      options.onStepStart?.(step.id, step.description);
      const stepStart = Date.now();
      let stepStatus: 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED' = 'PASSED';
      let stepError: string | undefined;
      const stepEvidence: string[] = [];

      try {
        // Execute Action if present
        if (step.action) {
          const actionResult = await this.adapter.executeAction(step.action);
          if (!actionResult.success) {
            stepStatus = 'FAILED';
            stepError = actionResult.error || 'Action failed';
          }
        }

        // Execute Assertion if present
        if (step.assertion && stepStatus === 'PASSED') {
          const assertionResult = await this.adapter.executeAssertion(step.assertion);
          if (!assertionResult.passed) {
            stepStatus = 'FAILED';
            stepError = assertionResult.message || 'Assertion failed';

            // Capture automatic screenshot evidence on assertion failure
            try {
              const failureEv = await this.adapter.captureEvidence(
                'SCREENSHOT',
                `Failure snapshot for step: ${step.id}`
              );
              this.evidenceStore.push(failureEv);
              stepEvidence.push(failureEv.id);
            } catch {
              // Ignore snapshot capture errors
            }

            // Create Finding
            const finding: Finding = {
              id: `FIND-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
              title: `Failed assertion: ${step.assertion.type}`,
              description: stepError,
              severity: step.assertion.critical ? 'HIGH' : 'MEDIUM',
              status: 'CONFIRMED',
              fixVerification: 'UNVERIFIED',
              platform: this.plan.platform,
              testCaseId: testCase.id,
              preconditions: [`Target app: ${this.plan.targetApp}`],
              reproductionSteps: [step.description],
              expectedBehavior: JSON.stringify(step.assertion.expected ?? 'true'),
              actualBehavior: String(assertionResult.actual ?? stepError),
              evidenceIds: [...stepEvidence],
              reproducibilityCount: 1,
              reproducibilitySuccessRate: 1.0,
              detectedAt: new Date().toISOString(),
              metadata: {},
            };
            this.findings.push(finding);
          }
        }
      } catch (err: any) {
        stepStatus = 'FAILED';
        stepError = err.message;
      }

      const stepDuration = Date.now() - stepStart;
      const result: StepExecutionResult = {
        stepId: step.id,
        status: stepStatus,
        durationMs: stepDuration,
        error: stepError,
        evidenceIds: stepEvidence,
      };

      stepResults.push(result);
      options.onStepEnd?.(result);

      if (stepStatus === 'FAILED') {
        testStatus = 'FAILED';
        if (!step.continueOnFailure) {
          break;
        }
      }
    }

    return {
      testCaseId: testCase.id,
      title: testCase.title,
      status: testStatus,
      durationMs: Date.now() - testCaseStart,
      stepResults,
      error: fatalError,
      evidenceIds: stepResults.flatMap((s) => s.evidenceIds),
      attemptCount: 1,
    };
  }

  private buildReport(): QARunReport {
    const totalTests = this.testResults.length;
    const passed = this.testResults.filter((r) => r.status === 'PASSED').length;
    const failed = this.testResults.filter((r) => r.status === 'FAILED').length;
    const blocked = this.testResults.filter((r) => r.status === 'BLOCKED').length;
    const skipped = this.testResults.filter((r) => r.status === 'SKIPPED').length;
    const error = this.testResults.filter((r) => r.status === 'ERROR').length;

    let overallStatus: 'PASSED' | 'FAILED' | 'BLOCKED' | 'PARTIAL' = 'PASSED';
    if (failed > 0 || error > 0) {
      overallStatus = 'FAILED';
    } else if (blocked > 0) {
      overallStatus = 'BLOCKED';
    }

    // Calculate deterministic trust score
    const deterministicAssertionsCount = this.plan.scenarios.reduce(
      (acc, s) => acc + s.steps.filter((st) => !!st.assertion).length,
      0
    );
    const evidenceArtifactsCount = this.evidenceStore.length;
    
    // Score based on verified assertions and evidence
    let trustScoreValue = 100;
    if (totalTests === 0) {
      trustScoreValue = 0;
    } else {
      const passRate = passed / totalTests;
      trustScoreValue = Math.round(passRate * 70 + (evidenceArtifactsCount > 0 ? 30 : 0));
    }

    const trustScore: TrustScore = {
      score: trustScoreValue,
      deterministicAssertionsCount,
      evidenceArtifactsCount,
      reproducibilityScore: 100,
      coverageScore: totalTests > 0 ? 100 : 0,
      honestyPenalty: 0,
      summary: `Evaluated ${totalTests} tests with ${deterministicAssertionsCount} deterministic assertions and ${evidenceArtifactsCount} evidence artifacts.`,
    };

    return {
      runId: `run-${Date.now()}`,
      projectName: this.plan.name,
      targetApp: this.plan.targetApp,
      platform: this.plan.platform,
      startedAt: new Date(this.startTime).toISOString(),
      finishedAt: new Date(this.endTime).toISOString(),
      durationMs: this.endTime - this.startTime,
      overallStatus,
      summary: {
        totalTests,
        passed,
        failed,
        blocked,
        skipped,
        error,
      },
      trustScore,
      capabilities: this.capabilities,
      testResults: this.testResults,
      findings: this.findings,
      evidence: this.evidenceStore,
      environmentInfo: {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
      },
    };
  }
}
