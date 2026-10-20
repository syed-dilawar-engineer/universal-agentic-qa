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
import {
  TrustScorerOptions,
  TrustScoreInput,
  TrustScorerWeights,
} from './types.js';

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

    // Edge case: No tests executed
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

    // 1. Deterministic Assertions Count & Quality
    const { count: deterministicAssertionsCount, qualityScore: assertionQualityScore } =
      this.evaluateAssertions(testResults, testPlan);

    let assertionScore = 0;
    if (deterministicAssertionsCount > 0) {
      // Density: assertions per test case
      const density = deterministicAssertionsCount / Math.max(1, totalTests);
      // Density score: 2+ assertions per test gives 100%, 1 gives 75%, 0 gives 0%
      const densityScore = Math.min(100, density >= 2 ? 100 : density * 75);
      assertionScore = Math.round(densityScore * assertionQualityScore);
    }

    // 2. Evidence Artifacts Backing
    const evidenceArtifactsCount = evidence.length;
    const evidenceScore = this.evaluateEvidence(testResults, evidence, findings);

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
          // If metadata has assertion info or if step passed with duration > 0
          if ((step as any).assertionType) {
            count++;
            weightedQualitySum += this.getAssertionQualityWeight({ type: (step as any).assertionType } as any);
          } else {
            // Count step as a deterministic verification check
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
    findings: Finding[]
  ): number {
    if (evidence.length === 0) {
      // 0 evidence captured across entire run
      return 0;
    }

    let score = 50; // Base score for having evidence

    // Multimodal richness bonus (screenshots + logs)
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

    // Check failure backing
    const failedTests = testResults.filter((r) => r.status === 'FAILED' || r.status === 'ERROR');
    if (failedTests.length > 0) {
      const failedWithEvidence = failedTests.filter(
        (t) => (t.evidenceIds && t.evidenceIds.length > 0) || t.stepResults.some((s) => s.evidenceIds && s.evidenceIds.length > 0)
      );
      const failureBackingRate = failedWithEvidence.length / failedTests.length;
      // If failed tests lack evidence, penalize evidenceScore heavily
      score = Math.round(score * (0.3 + 0.7 * failureBackingRate));
    }

    return Math.min(100, Math.max(0, score));
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
        // If passed on 1st attempt = 100%, if passed after 3 attempts = 1/3
        successfulAttempts += 1;
      }
    }

    let testStability = totalAttempts > 0 ? (successfulAttempts / totalAttempts) * 100 : 100;

    // Evaluate findings reproducibility
    let findingReproducibility = 100;
    if (findings.length > 0) {
      const rates = findings.map((f) => {
        if (f.status === 'CONFIRMED') {
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

    // Combine test stability and defect reproducibility
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

    // Explicit counts from input
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

    // Check phantom passes: tests marked PASSED that have 0 steps or empty execution
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

      // Claimed confirmed with 0 reproducibility attempts
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
      trustLevel = 'Untrusted (Insufficient Proof)';
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
