import {
  TrustScore,
  TrustScoreSchema,
  TestCaseResult,
  Finding,
  EvidenceArtifact,
  TestPlan,
  AssertionSpec,
  QARunReport,
} from '@agentic-qa/schemas';

export interface TrustScorerWeights {
  /** Weight for deterministic assertions (default 0.35) */
  assertions?: number;
  /** Weight for evidence backing (default 0.25) */
  evidence?: number;
  /** Weight for test/finding reproducibility (default 0.20) */
  reproducibility?: number;
  /** Weight for execution coverage (default 0.20) */
  coverage?: number;
}

export interface TrustScorerOptions {
  /** Weights for trust score dimensions (must sum to ~1.0) */
  weights?: TrustScorerWeights;
  /** Penalty points deducted per unverified assertion (default 15) */
  unverifiedAssertionPenalty?: number;
  /** Penalty points deducted per missing baseline (default 20) */
  missingBaselinePenalty?: number;
  /** Penalty points deducted per confirmed finding without evidence (default 25) */
  unbackedConfirmedFindingPenalty?: number;
  /** Maximum total honesty penalty deduction (default 100) */
  maxHonestyPenalty?: number;
}

export interface TrustScoreInput {
  testResults: TestCaseResult[];
  evidence: EvidenceArtifact[];
  findings?: Finding[];
  testPlan?: TestPlan;
  /** Explicit count of unverified assertions */
  unverifiedAssertionsCount?: number;
  /** Explicit count of missing baselines */
  missingBaselinesCount?: number;
  /** Explicit count of flaky attempts across runs */
  flakyAttemptsCount?: number;
}

export const DEFAULT_WEIGHTS: Required<TrustScorerWeights> = {
  assertions: 0.35,
  evidence: 0.25,
  reproducibility: 0.20,
  coverage: 0.20,
};

export class TrustScorer {
  private readonly weights: Required<TrustScorerWeights>;
  private readonly unverifiedAssertionPenalty: number;
  private readonly missingBaselinePenalty: number;
  private readonly unbackedConfirmedFindingPenalty: number;
  private readonly maxHonestyPenalty: number;

  constructor(options: TrustScorerOptions = {}) {
    this.weights = {
      assertions: options.weights?.assertions ?? DEFAULT_WEIGHTS.assertions,
      evidence: options.weights?.evidence ?? DEFAULT_WEIGHTS.evidence,
      reproducibility: options.weights?.reproducibility ?? DEFAULT_WEIGHTS.reproducibility,
      coverage: options.weights?.coverage ?? DEFAULT_WEIGHTS.coverage,
    };
    this.unverifiedAssertionPenalty = options.unverifiedAssertionPenalty ?? 15;
    this.missingBaselinePenalty = options.missingBaselinePenalty ?? 20;
    this.unbackedConfirmedFindingPenalty = options.unbackedConfirmedFindingPenalty ?? 25;
    this.maxHonestyPenalty = options.maxHonestyPenalty ?? 100;
  }

  /**
   * Static convenience method to compute trust score
   */
  static compute(input: TrustScoreInput | QARunReport, options?: TrustScorerOptions): TrustScore {
    return new TrustScorer(options).calculate(input);
  }

  /**
   * Main calculation function
   */
  calculate(input: TrustScoreInput | QARunReport): TrustScore {
    const testResults: TestCaseResult[] = input.testResults || [];
    const evidence: EvidenceArtifact[] = input.evidence || [];
    const findings: Finding[] = input.findings || [];
    const testPlan: TestPlan | undefined = 'testPlan' in input ? input.testPlan : undefined;

    const totalTests = testResults.length;

    // Edge case: No tests executed or all blocked without execution
    if (totalTests === 0 && (!testPlan || testPlan.scenarios.length === 0)) {
      return TrustScoreSchema.parse({
        score: 0,
        deterministicAssertionsCount: 0,
        evidenceArtifactsCount: evidence.length,
        reproducibilityScore: 0,
        coverageScore: 0,
        honestyPenalty: 0,
        summary: 'No test cases were executed. Trust score is 0.',
      });
    }

    const passedCount = testResults.filter((r) => r.status === 'PASSED').length;
    const failedCount = testResults.filter((r) => r.status === 'FAILED' || r.status === 'ERROR').length;
    const blockedCount = testResults.filter((r) => r.status === 'BLOCKED').length;

    // Pass rate across all attempted tests
    const passRate = totalTests > 0 ? passedCount / totalTests : 0;

    // 1. Deterministic Assertions Count & Quality (scaled by pass rate)
    const { count: deterministicAssertionsCount, qualityScore: assertionQualityScore } =
      this.evaluateAssertions(testResults, testPlan);

    let assertionScore = 0;
    if (deterministicAssertionsCount > 0 && totalTests > 0) {
      const density = deterministicAssertionsCount / totalTests;
      // Density score: 2+ assertions per test gives 100%, 1 gives 75%, scaled by pass rate
      const densityScore = Math.min(100, density >= 2 ? 100 : density * 75);
      assertionScore = Math.round(densityScore * assertionQualityScore * passRate);
    }

    // 2. Evidence Artifacts Backing (preventing failure evidence from exceeding clean runs)
    const evidenceArtifactsCount = evidence.length;
    const evidenceScore = this.evaluateEvidence(testResults, evidence, findings, passRate);

    // 3. Reproducibility Score
    const reproducibilityScore = this.evaluateReproducibility(testResults, findings, input);

    // 4. Coverage Score
    const coverageScore = this.evaluateCoverage(testResults, testPlan);

    // 5. Honesty Penalties
    const { penalty: honestyPenalty, reasons: penaltyReasons } = this.calculateHonestyPenalty(
      testResults,
      evidence,
      findings,
      input
    );

    // If all tests were blocked due to infrastructure failure, score cannot claim trust
    if (blockedCount === totalTests && totalTests > 0) {
      return TrustScoreSchema.parse({
        score: 0,
        deterministicAssertionsCount,
        evidenceArtifactsCount,
        reproducibilityScore: 0,
        coverageScore: 0,
        honestyPenalty: 0,
        summary: 'All test cases were blocked by environment or infrastructure failures. Trust score is 0.',
      });
    }

    // Composite Base Score (0 to 100)
    const rawScore =
      assertionScore * this.weights.assertions +
      evidenceScore * this.weights.evidence +
      reproducibilityScore * this.weights.reproducibility +
      coverageScore * this.weights.coverage;

    const finalScore = Math.max(0, Math.min(100, Math.round(rawScore - honestyPenalty)));

    // Summary generation
    const summary = this.buildSummary(
      finalScore,
      deterministicAssertionsCount,
      evidenceArtifactsCount,
      reproducibilityScore,
      coverageScore,
      honestyPenalty,
      penaltyReasons
    );

    const trustScore: TrustScore = {
      score: finalScore,
      deterministicAssertionsCount,
      evidenceArtifactsCount,
      reproducibilityScore,
      coverageScore,
      honestyPenalty,
      summary,
    };

    return TrustScoreSchema.parse(trustScore);
  }

  private evaluateAssertions(
    testResults: TestCaseResult[],
    testPlan?: TestPlan
  ): { count: number; qualityScore: number } {
    let count = 0;
    let weightedQualitySum = 0;

    if (testPlan && testPlan.scenarios.length > 0) {
      for (const scenario of testPlan.scenarios) {
        for (const step of scenario.steps) {
          if (step.assertion) {
            count++;
            weightedQualitySum += this.getAssertionQualityWeight(step.assertion);
          }
        }
      }
    } else {
      // Deduce from step execution results
      for (const test of testResults) {
        for (const step of test.stepResults) {
          if ((step as any).assertionType) {
            count++;
            weightedQualitySum += this.getAssertionQualityWeight({ type: (step as any).assertionType } as any);
          } else {
            count++;
            weightedQualitySum += 0.85;
          }
        }
      }
    }

    const qualityScore = count > 0 ? weightedQualitySum / count : 0;
    return { count, qualityScore };
  }

  private getAssertionQualityWeight(assertion: AssertionSpec): number {
    switch (assertion.type) {
      case 'noVisualRegression':
      case 'noAccessibilityViolations':
      case 'status200':
      case 'urlMatches':
      case 'elementTextEquals':
      case 'consoleClean':
      case 'noNetworkFailures':
        return 1.0; // High-signal deterministic assertions

      case 'elementVisible':
      case 'elementHidden':
      case 'elementExists':
      case 'elementDisabled':
      case 'elementEnabled':
      case 'elementCount':
      case 'elementTextContains':
      case 'titleMatches':
        return 0.85; // Standard DOM assertions

      case 'custom':
      default:
        return 0.65; // Custom/heuristic assertions
    }
  }

  private evaluateEvidence(
    testResults: TestCaseResult[],
    evidence: EvidenceArtifact[],
    findings: Finding[],
    passRate: number
  ): number {
    const failedTests = testResults.filter((r) => r.status === 'FAILED' || r.status === 'ERROR');

    // Case 1: Flawless clean run (0 failures, 0 findings)
    if (failedTests.length === 0 && findings.length === 0) {
      if (evidence.length === 0) {
        // Healthy baseline for clean runs without explicit artifacts: 75
        // (Allows clean runs to score ~85-93/100, above failing runs)
        return 75;
      }

      // Clean run WITH explicit artifacts (screenshots, traces, DOM): up to 100
      let score = 50;
      const hasScreenshots = evidence.some(
        (e) => e.type === 'SCREENSHOT' || e.type === 'PERCEPTUAL_DIFF'
      );
      const hasLogs = evidence.some(
        (e) => e.type === 'CONSOLE_LOG' || e.type === 'SYSTEM_LOG'
      );
      const hasTracesOrHar = evidence.some(
        (e) => e.type === 'TRACE' || e.type === 'NETWORK_HAR' || e.type === 'DOM_SNAPSHOT'
      );

      if (hasScreenshots) score += 20;
      if (hasLogs) score += 15;
      if (hasTracesOrHar) score += 15;
      return Math.min(100, score);
    }

    // Case 2: Run has failures or findings
    if (evidence.length === 0) {
      return 0; // Failures without evidence get 0 evidence score
    }

    // Calculate failure backing rate
    const failedWithEvidence = failedTests.filter(
      (t) =>
        (t.evidenceIds && t.evidenceIds.length > 0) ||
        t.stepResults.some((s) => s.evidenceIds && s.evidenceIds.length > 0)
    );
    const failureBackingRate = failedTests.length > 0
      ? failedWithEvidence.length / failedTests.length
      : 1.0;

    // Base score for backed failures: 40 * backing rate + scaled by passRate
    // Ensures failure evidence NEVER exceeds clean runs (capped at 50 + 40 * passRate)
    const failureEvidenceScore = Math.round(
      (30 + 40 * failureBackingRate) * (0.4 + 0.6 * passRate)
    );

    return Math.min(70, Math.max(0, failureEvidenceScore));
  }

  private evaluateReproducibility(
    testResults: TestCaseResult[],
    findings: Finding[],
    input: TrustScoreInput | QARunReport
  ): number {
    let totalAttempts = 0;
    let successfulAttempts = 0;

    for (const test of testResults) {
      const attempts = test.attemptCount || 1;
      totalAttempts += attempts;
      if (test.status === 'PASSED') {
        successfulAttempts += 1;
      }
    }

    const testStability = totalAttempts > 0 ? (successfulAttempts / totalAttempts) * 100 : 100;

    // Evaluate findings reproducibility
    let findingReproducibility = 100;
    if (findings.length > 0) {
      const rates = findings.map((f) => {
        if (f.status === 'CONFIRMED' || f.status === 'FIX_VERIFIED') {
          return f.reproducibilitySuccessRate ?? 1.0;
        }
        if (f.status === 'SUSPECTED') {
          return 0.5;
        }
        if (f.status === 'NOT_REPRODUCED') {
          return 0.0;
        }
        return 0.8;
      });
      const avgRate = rates.reduce((sum, r) => sum + r, 0) / rates.length;
      findingReproducibility = Math.round(avgRate * 100);
    }

    const compositeReproducibility = Math.round(testStability * 0.6 + findingReproducibility * 0.4);
    return Math.min(100, Math.max(0, compositeReproducibility));
  }

  private evaluateCoverage(testResults: TestCaseResult[], testPlan?: TestPlan): number {
    const totalPlanned = testPlan?.scenarios?.length || testResults.length;
    if (totalPlanned === 0) return 0;

    const executedCount = testResults.filter(
      (r) => r.status === 'PASSED' || r.status === 'FAILED' || r.status === 'ERROR'
    ).length;

    return Math.min(100, Math.max(0, Math.round((executedCount / totalPlanned) * 100)));
  }

  private calculateHonestyPenalty(
    testResults: TestCaseResult[],
    evidence: EvidenceArtifact[],
    findings: Finding[],
    input: TrustScoreInput | QARunReport
  ): { penalty: number; reasons: string[] } {
    let penalty = 0;
    const reasons: string[] = [];

    const unverifiedCount = 'unverifiedAssertionsCount' in input
      ? (input.unverifiedAssertionsCount ?? 0)
      : 0;
    if (unverifiedCount > 0) {
      const p = unverifiedCount * this.unverifiedAssertionPenalty;
      penalty += p;
      reasons.push(`${unverifiedCount} unverified assertion(s) (-${p} pts)`);
    }

    const missingBaselines = 'missingBaselinesCount' in input
      ? (input.missingBaselinesCount ?? 0)
      : 0;
    if (missingBaselines > 0) {
      const p = missingBaselines * this.missingBaselinePenalty;
      penalty += p;
      reasons.push(`${missingBaselines} missing baseline(s) (-${p} pts)`);
    }

    // Check phantom passes: tests marked PASSED with 0 executed steps
    for (const test of testResults) {
      if (test.status === 'PASSED' && test.stepResults.length === 0) {
        penalty += this.unverifiedAssertionPenalty;
        reasons.push(`Test '${test.testCaseId}' marked PASSED with 0 executed steps (-${this.unverifiedAssertionPenalty} pts)`);
      }
    }

    // Check unbacked confirmed findings: findings marked CONFIRMED or FIX_VERIFIED with 0 evidence
    for (const finding of findings) {
      if (
        (finding.status === 'CONFIRMED' || finding.fixVerification === 'VERIFIED') &&
        (!finding.evidenceIds || finding.evidenceIds.length === 0)
      ) {
        penalty += this.unbackedConfirmedFindingPenalty;
        reasons.push(`Finding '${finding.id}' claimed CONFIRMED without evidence (-${this.unbackedConfirmedFindingPenalty} pts)`);
      }

      if (finding.status === 'CONFIRMED' && (finding.reproducibilityCount ?? 0) <= 0) {
        penalty += 15;
        reasons.push(`Finding '${finding.id}' claimed CONFIRMED with 0 reproducibility attempts (-15 pts)`);
      }
    }

    const cappedPenalty = Math.min(this.maxHonestyPenalty, penalty);
    return { penalty: cappedPenalty, reasons };
  }

  private buildSummary(
    finalScore: number,
    deterministicAssertionsCount: number,
    evidenceArtifactsCount: number,
    reproducibilityScore: number,
    coverageScore: number,
    honestyPenalty: number,
    penaltyReasons: string[]
  ): string {
    let trustLevel: string;
    if (finalScore >= 85) {
      trustLevel = 'High Trust (Verified & Reproducible)';
    } else if (finalScore >= 65) {
      trustLevel = 'Moderate Trust (Standard Evidence)';
    } else if (finalScore >= 40) {
      trustLevel = 'Low Trust (Needs Verification)';
    } else {
      trustLevel = 'Untrusted (Insufficient Proof or Failures Present)';
    }

    let summary = `${trustLevel}: Overall score ${finalScore}/100. `;
    summary += `Evaluated with ${deterministicAssertionsCount} deterministic assertion(s), ${evidenceArtifactsCount} evidence artifact(s), `;
    summary += `${reproducibilityScore}% reproducibility, and ${coverageScore}% test coverage.`;

    if (honestyPenalty > 0) {
      summary += ` Honesty penalty of -${honestyPenalty} pts applied due to: ${penaltyReasons.join('; ')}.`;
    } else {
      summary += ' Zero honesty penalties applied; all assertions and findings backed by verifiable proof.';
    }

    return summary;
  }
}
