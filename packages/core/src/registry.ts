import { Platform, CapabilityDescriptor } from '@agentic-qa/schemas';
import { PlatformAdapter } from './adapter.js';
import { QAUnsupportedError } from './errors.js';

export class CapabilityRegistry {
  private adapters: Map<string, PlatformAdapter> = new Map();

  registerAdapter(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  getAdapter(id: string): PlatformAdapter | undefined {
    return this.adapters.get(id);
  }

  getAdaptersForPlatform(platform: Platform): PlatformAdapter[] {
    return Array.from(this.adapters.values()).filter((a) => a.platform === platform);
  }

  getAllAdapters(): PlatformAdapter[] {
    return Array.from(this.adapters.values());
  }

  async probeAllCapabilities(): Promise<CapabilityDescriptor[]> {
    const descriptors: CapabilityDescriptor[] = [];
    for (const adapter of this.adapters.values()) {
      try {
        const desc = await adapter.getCapability();
        descriptors.push(desc);
      } catch (err: any) {
        descriptors.push({
          id: adapter.id,
          name: adapter.name,
          platform: adapter.platform,
          state: 'BLOCKED',
          reason: `Adapter check crashed: ${err.message}`,
          requiredTools: [],
          missingTools: [],
          metadata: {},
        });
      }
    }
    return descriptors;
  }

  async resolveAdapterForTarget(platform: Platform): Promise<PlatformAdapter> {
    const candidates = this.getAdaptersForPlatform(platform);
    if (candidates.length === 0) {
      throw new QAUnsupportedError(
        `No adapter registered for platform: ${platform}`,
        platform
      );
    }

    // Check capabilities in order
    for (const adapter of candidates) {
      const cap = await adapter.getCapability();
      if (cap.state === 'AVAILABLE') {
        return adapter;
      }
    }

    // If none are AVAILABLE, return the first one (caller will observe BLOCKED/UNAVAILABLE error)
    return candidates[0];
  }
}
