import fs from 'node:fs';
import path from 'node:path';
import { QAConfig, QAConfigSchema } from '@agentic-qa/schemas';

export function loadConfig(configPath?: string): QAConfig {
  const resolvedPath = configPath
    ? path.resolve(process.cwd(), configPath)
    : path.resolve(process.cwd(), 'qa.config.json');

  if (fs.existsSync(resolvedPath)) {
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = JSON.parse(raw);
      return QAConfigSchema.parse(parsed);
    } catch (err: any) {
      throw new Error(`Failed to parse configuration file at ${resolvedPath}: ${err.message}`);
    }
  }

  // Return default config if no file exists
  return QAConfigSchema.parse({});
}

export function saveConfig(config: QAConfig, configPath?: string): void {
  const resolvedPath = configPath
    ? path.resolve(process.cwd(), configPath)
    : path.resolve(process.cwd(), 'qa.config.json');

  const validated = QAConfigSchema.parse(config);
  fs.writeFileSync(resolvedPath, JSON.stringify(validated, null, 2), 'utf8');
}
