import { CapabilityRegistry } from '@agentic-qa/core';
import { CliWebAdapter } from '../adapters/web-adapter.js';
import { CliMobileAdapter } from '../adapters/mobile-adapter.js';

export function createDefaultRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.registerAdapter(new CliWebAdapter());
  registry.registerAdapter(new CliMobileAdapter());
  return registry;
}
