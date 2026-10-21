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
import { QABlockedError, QATimeoutError, QACircuitBreakerError } from './errors.js';
import { TrustScorer } from './trust-scorer.js';
import { redactSecrets, sanitizeObject } from './sanitizer.js';

export interface ExecutionOptions {
  onStepStart?: (stepId: string, desc: string) => void;
  onStepEnd?: (stepResult: StepExecutionResult) => void;
  onTestCaseStart?: (testCase: TestCase) => void;
  onTestCaseEnd?: (result: TestCaseResult) => void;
  maxDurationMs?: number;
  maxActionsPerTest?: number;
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
        // Enforce global execution timeout before starting test case
        if (options.maxDurationMs && Date.now() - this.startTime > options.maxDurationMs) {
          throw new QATimeoutError(
            `Execution exceeded maxDurationMs of ${options.maxDurationMs}ms`,
            options.maxDurationMs
          );
        }

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

    const maxActions = options.maxActionsPerTest ?? 1000;
    let actionCount = 0;

    for (const step of testCase.steps) {
      // 1. Enforce global duration limit during step progression
      if (options.maxDurationMs && Date.now() - this.startTime > options.maxDurationMs) {
        fatalError = `Execution exceeded maxDurationMs limit (${options.maxDurationMs}ms)`;
        testStatus = 'FAILED';
        break;
      }

      // 2. Enforce per-test timeout
      const perTestTimeout = testCase.timeoutMs || 60000;
      if (Date.now() - testCaseStart > perTestTimeout) {
        fatalError = `Test case "${testCase.id}" exceeded timeout of ${perTestTimeout}ms`;
        testStatus = 'FAILED';
        break;
      }

      options.onStepStart?.(step.id, step.description);
      const stepStart = Date.now();
      let stepStatus: 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED' = 'PASSED';
      let stepError: string | undefined;
      const stepEvidence: string[] = [];

      try {
        // Enforce per-test action limit
        if (step.action) {
          actionCount++;
          if (actionCount > maxActions) {
            stepStatus = 'FAILED';
            stepError = `Action limit exceeded: maxActionsPerTest (${maxActions}) reached on test case "${testCase.id}"`;
            fatalError = stepError;
            testStatus = 'FAILED';

            stepResults.push({
              stepId: step.id,
              status: stepStatus,
              durationMs: Date.now() - stepStart,
              error: stepError,
              evidenceIds: [],
            });
            break;
          }

          const actionResult = await this.adapter.executeAction(step.action);
          if (!actionResult.success) {
            stepStatus = 'FAILED';
            stepError = actionResult.error ? redactSecrets(actionResult.error) : 'Action failed';

            // Capture automatic failure evidence on action failure
            try {
              const failureEv = await this.adapter.captureEvidence(
                'SCREENSHOT',
                `Action failure snapshot for step: ${step.id}`
              );
              this.evidenceStore.push(failureEv);
              stepEvidence.push(failureEv.id);
            } catch {
              // Ignore snapshot capture errors
            }

            // Create Finding with reproduction context for action failure
            const finding: Finding = {
              id: `FIND-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
              title: `Failed action: ${step.action.type}`,
              description: stepError,
              severity: 'HIGH',
              status: 'CONFIRMED',
              fixVerification: 'UNVERIFIED',
              platform: this.plan.platform,
              testCaseId: testCase.id,
              preconditions: [`Target app: ${this.plan.targetApp}`],
              reproductionSteps: testCase.steps.map((s) => s.description),
              expectedBehavior: `Action "${step.action.type}" should execute successfully`,
              actualBehavior: stepError,
              evidenceIds: [...stepEvidence],
              reproducibilityCount: 1,
              reproducibilitySuccessRate: 1.0,
              detectedAt: new Date().toISOString(),
              metadata: {
                failedStepId: step.id,
                failedAction: step.action,
                actionError: actionResult.error,
                scenario: testCase,
              },
            };
            this.findings.push(finding);
          }
        }

        // Execute Assertion if present and action succeeded
        if (step.assertion && stepStatus === 'PASSED') {
          const assertionResult = await this.adapter.executeAssertion(step.assertion);
          if (!assertionResult.passed) {
            stepStatus = 'FAILED';
            stepError = assertionResult.message
              ? redactSecrets(assertionResult.message)
              : 'Assertion failed';

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

            // Create Finding with complete reproduction context and scenario
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
              reproductionSteps: testCase.steps.map((s) => s.description),
              expectedBehavior: JSON.stringify(step.assertion.expected ?? 'true'),
              actualBehavior: String(assertionResult.actual ?? stepError),
              evidenceIds: [...stepEvidence],
              reproducibilityCount: 1,
              reproducibilitySuccessRate: 1.0,
              detectedAt: new Date().toISOString(),
              metadata: {
                failedStepId: step.id,
                failedAssertion: step.assertion,
                scenario: testCase,
              },
            };
            this.findings.push(finding);
          }
        }
      } catch (err: any) {
        stepStatus = 'FAILED';
        stepError = redactSecrets(err.message || String(err));

        try {
          const failureEv = await this.adapter.captureEvidence(
            'SCREENSHOT',
            `Step error snapshot for step: ${step.id}`
          );
          this.evidenceStore.push(failureEv);
          stepEvidence.push(failureEv.id);
        } catch {
          // Ignore snapshot capture errors
        }

        const finding: Finding = {
          id: `FIND-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          title: `Step execution error: ${step.id}`,
          description: stepError,
          severity: 'HIGH',
          status: 'CONFIRMED',
          fixVerification: 'UNVERIFIED',
          platform: this.plan.platform,
          testCaseId: testCase.id,
          preconditions: [`Target app: ${this.plan.targetApp}`],
          reproductionSteps: testCase.steps.map((s) => s.description),
          expectedBehavior: 'Step should complete without runtime exception',
          actualBehavior: stepError,
          evidenceIds: [...stepEvidence],
          reproducibilityCount: 1,
          reproducibilitySuccessRate: 1.0,
          detectedAt: new Date().toISOString(),
          metadata: {
            failedStepId: step.id,
            error: err.message,
            scenario: testCase,
          },
        };
        this.findings.push(finding);
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
      error: fatalError ? redactSecrets(fatalError) : undefined,
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

    // Centralized deterministic trust scoring using TrustScorer.compute()
    const trustScore = TrustScorer.compute({
      testResults: this.testResults,
      evidence: this.evidenceStore,
      findings: this.findings,
      testPlan: this.plan,
    });

    const report: QARunReport = {
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

    return sanitizeObject(report);
  }
}
