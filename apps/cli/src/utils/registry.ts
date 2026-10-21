import { CapabilityRegistry } from '@agentic-qa/core';
import { WebAdapter } from '@agentic-qa/adapter-web';
import { MobileAdapter } from '@agentic-qa/adapter-mobile';
import { DesktopAdapter } from '@agentic-qa/adapter-desktop';

export function createDefaultRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.registerAdapter(new WebAdapter());
  registry.registerAdapter(new MobileAdapter());
  registry.registerAdapter(new DesktopAdapter());
  return registry;
}
