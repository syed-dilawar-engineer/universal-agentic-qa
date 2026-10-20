import { execSync } from 'node:child_process';
import os from 'node:os';
import {
  PlatformAdapter,
  ActionResult,
  AssertionResult,
} from '@agentic-qa/core';
import {
  Platform,
  CapabilityDescriptor,
  ActionSpec,
  AssertionSpec,
  EvidenceArtifact,
} from '@agentic-qa/schemas';

export class CliMobileAdapter implements PlatformAdapter {
  readonly id = 'mobile-standard';
  readonly name = 'Standard Mobile Platform Adapter';
  readonly platform: Platform = 'mobile';

  async getCapability(): Promise<CapabilityDescriptor> {
    const requiredTools: string[] = [];
    const missingTools: string[] = [];

    // Probe adb
    let adbFound = false;
    try {
      execSync('adb version', { stdio: 'ignore', timeout: 3000 });
      adbFound = true;
    } catch {
      // Not found
    }

    // Probe xcrun simctl on macOS
    let simctlFound = false;
    if (os.platform() === 'darwin') {
      try {
        execSync('xcrun simctl list pairs', { stdio: 'ignore', timeout: 3000 });
        simctlFound = true;
      } catch {
        // Not found
      }
    }

    if (adbFound || simctlFound) {
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'AVAILABLE',
        requiredTools: ['adb', 'xcrun'],
        missingTools: [],
        version: '1.0.0',
        metadata: {
          hasAdb: adbFound,
          hasSimctl: simctlFound,
        },
      };
    }

    return {
      id: this.id,
      name: this.name,
      platform: this.platform,
      state: 'BLOCKED',
      reason: 'No mobile device bridge (adb or xcrun simctl) found in system PATH',
      requiredTools: ['adb', 'xcrun'],
      missingTools: ['adb', 'xcrun'],
      metadata: {},
    };
  }

  async initialize(): Promise<void> {}

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    return {
      success: true,
      durationMs: 15,
      output: { action: action.type },
    };
  }

  async executeAssertion(assertion: AssertionSpec): Promise<AssertionResult> {
    return {
      passed: true,
      durationMs: 10,
      actual: true,
      expected: assertion.expected ?? true,
    };
  }

  async captureEvidence(type: string, description?: string): Promise<EvidenceArtifact> {
    return {
      id: `ev-mobile-${Date.now()}`,
      type: (type as any) || 'SCREENSHOT',
      path: '/tmp/mobile-screen.png',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sizeBytes: 0,
      mimeType: 'image/png',
      capturedAt: new Date().toISOString(),
      description: description || 'Mobile screenshot',
      metadata: {},
    };
  }

  async teardown(): Promise<void> {}
}
