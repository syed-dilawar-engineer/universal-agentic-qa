import {
  CapabilityDescriptor,
  Platform,
} from '@agentic-qa/schemas';
import {
  DiscoverCapabilitiesInput,
  DiscoverCapabilitiesOutput,
  McpServerContext,
} from '../types.js';
import { probeSystemCapabilities } from '../adapters/system-prober.js';

export async function handleDiscoverCapabilities(
  input: DiscoverCapabilitiesInput,
  context: McpServerContext
): Promise<DiscoverCapabilitiesOutput> {
  const { platform, detailed } = input;

  // 1. Probe registered adapters in CapabilityRegistry
  const adapterCaps = await context.registry.probeAllCapabilities();

  // 2. Probe system OS / environment capabilities
  const systemCaps = probeSystemCapabilities();

  // Combine and deduplicate by platform/id
  const seenIds = new Set<string>();
  let allCaps: CapabilityDescriptor[] = [];

  for (const cap of [...adapterCaps, ...systemCaps]) {
    if (!seenIds.has(cap.id)) {
      seenIds.add(cap.id);
      allCaps.push(cap);
    }
  }

  // Filter by platform if requested
  if (platform) {
    allCaps = allCaps.filter((c) => c.platform === platform);
  }

  // Calculate summary counts
  const summary = {
    total: allCaps.length,
    available: allCaps.filter((c) => c.state === 'AVAILABLE').length,
    unavailable: allCaps.filter((c) => c.state === 'UNAVAILABLE').length,
    unsupported: allCaps.filter((c) => c.state === 'UNSUPPORTED').length,
    blocked: allCaps.filter((c) => c.state === 'BLOCKED').length,
  };

  let readiness: 'ALL_READY' | 'PARTIALLY_READY' | 'NOT_READY' = 'NOT_READY';
  if (summary.available === summary.total && summary.total > 0) {
    readiness = 'ALL_READY';
  } else if (summary.available > 0) {
    readiness = 'PARTIALLY_READY';
  }

  // Generate truthful recommendations for blocked/unavailable tools
  const recommendations: string[] = [];
  for (const cap of allCaps) {
    if (cap.state === 'BLOCKED') {
      if (cap.platform === 'web' && cap.missingTools.includes('chromium')) {
        recommendations.push(
          'Web automation blocked: install chromium browser via `npx playwright install chromium` or install Google Chrome.'
        );
      }
      if (cap.platform === 'mobile' && cap.missingTools.includes('adb')) {
        recommendations.push(
          'Android automation blocked: install Android SDK Platform Tools (adb) and configure ANDROID_HOME.'
        );
      }
      if (cap.platform === 'mobile' && cap.missingTools.includes('xcrun')) {
        recommendations.push(
          'iOS simulator automation blocked: install Xcode Command Line Tools via `xcode-select --install`.'
        );
      }
    }
  }

  if (summary.available > 0 && recommendations.length === 0) {
    recommendations.push('Environment is fully operational for executable platforms.');
  }

  // Format capabilities (strip heavy metadata if not detailed)
  const formattedCaps = detailed
    ? allCaps
    : allCaps.map((c) => ({
        id: c.id,
        name: c.name,
        platform: c.platform,
        state: c.state,
        reason: c.reason,
        requiredTools: c.requiredTools,
        missingTools: c.missingTools,
        metadata: {},
      }));

  return {
    timestamp: new Date().toISOString(),
    readiness,
    summary,
    capabilities: formattedCaps,
    recommendations: Array.from(new Set(recommendations)),
  };
}
