import { Finding } from '@agentic-qa/schemas';

/**
 * Enforces and formats tripartite defect titles:
 * [Module/Feature] [Condition/Trigger] -> [Unexpected Behavior]
 */
export function formatTripartiteTitle(finding: Finding): string {
  const rawTitle = (finding.title || '').trim();

  // If already matches tripartite format: [Module] [Trigger] -> [Unexpected Behavior]
  const tripartiteRegex = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*->\s*(.+)$/;
  const match = rawTitle.match(tripartiteRegex);
  if (match) {
    const mod = match[1].trim();
    const trig = match[2].trim();
    const beh = match[3].trim().replace(/^\[|\]$/g, '').trim();
    return `[${mod}] [${trig}] -> [${beh}]`;
  }

  // Derive [Module/Feature]
  const moduleName =
    finding.metadata?.module ||
    finding.metadata?.feature ||
    finding.rootCauseHypothesis?.suspectedComponent ||
    (finding.testCaseId ? `Feature: ${finding.testCaseId}` : undefined) ||
    finding.platform.toUpperCase();

  // Derive [Condition/Trigger]
  const trigger =
    finding.metadata?.trigger ||
    finding.metadata?.condition ||
    (finding.reproductionSteps && finding.reproductionSteps.length > 0
      ? finding.reproductionSteps[0]
      : undefined) ||
    (finding.preconditions && finding.preconditions.length > 0
      ? finding.preconditions[0]
      : undefined) ||
    'On Execution';

  // Derive [Unexpected Behavior]
  let behavior = rawTitle;
  if (behavior.includes(' -> ')) {
    const parts = behavior.split(' -> ');
    behavior = parts[parts.length - 1].trim();
  }
  behavior = behavior.replace(/^\[|\]$/g, '').trim();

  return `[${moduleName}] [${trigger}] -> [${behavior}]`;
}
