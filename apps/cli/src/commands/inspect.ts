import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@agentic-qa/core';
import { Platform } from '@agentic-qa/schemas';
import { CliLogger, createTable, pc } from '../output.js';

export interface InspectOptions {
  target?: string;
  config?: string;
  json?: boolean;
}

export interface InspectionResult {
  target: string;
  targetType: 'url' | 'directory' | 'mobile_package' | 'unknown';
  platform: Platform;
  framework?: string;
  reachable?: boolean;
  httpStatus?: number;
  entrypoints?: string[];
  details: Record<string, any>;
  recommendations: {
    suggestedAdapters: string[];
    suggestedPlan: string;
    viewports: string[];
  };
}

export async function inspectTarget(targetInput?: string, configPath?: string): Promise<InspectionResult> {
  let target = targetInput;
  let configuredPlatform: Platform = 'web';

  // If no target provided, check config
  if (!target) {
    try {
      const cfg = loadConfig(configPath);
      target = cfg.target.url || cfg.target.appPath || cfg.target.packageName || '.';
      configuredPlatform = cfg.target.platform;
    } catch {
      target = '.';
    }
  }

  // 1. URL Inspection
  if (/^https?:\/\//i.test(target)) {
    let reachable = false;
    let httpStatus: number | undefined;
    try {
      const res = await fetch(target, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
      reachable = true;
      httpStatus = res.status;
    } catch {
      reachable = false;
    }

    const parsedUrl = new URL(target);
    return {
      target,
      targetType: 'url',
      platform: 'web',
      reachable,
      httpStatus,
      details: {
        host: parsedUrl.host,
        protocol: parsedUrl.protocol,
        pathname: parsedUrl.pathname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80'),
      },
      recommendations: {
        suggestedAdapters: ['web-standard'],
        suggestedPlan: 'Smoke & Visual Web Navigation Suite',
        viewports: ['mobile-md (375x667)', 'desktop (1440x900)'],
      },
    };
  }

  // 2. Directory Inspection
  const resolvedPath = path.resolve(process.cwd(), target);
  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
    let framework = 'Generic Web / Node';
    let platform: Platform = 'web';
    const details: Record<string, any> = { path: resolvedPath };

    const pkgPath = path.join(resolvedPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        details.packageName = pkg.name;
        details.version = pkg.version;
        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
        };

        if (allDeps['next']) framework = 'Next.js';
        else if (allDeps['vite']) framework = 'Vite';
        else if (allDeps['react-native']) {
          framework = 'React Native';
          platform = 'mobile';
        } else if (allDeps['react']) framework = 'React';
        else if (allDeps['vue']) framework = 'Vue';
        else if (allDeps['@angular/core']) framework = 'Angular';
        else if (allDeps['electron']) {
          framework = 'Electron';
          platform = 'desktop';
        }

        details.scripts = Object.keys(pkg.scripts || {});
      } catch {
        // Ignore json parse error
      }
    }

    // Android/iOS project checks
    if (fs.existsSync(path.join(resolvedPath, 'android')) || fs.existsSync(path.join(resolvedPath, 'AndroidManifest.xml'))) {
      platform = 'mobile';
      framework = framework === 'Generic Web / Node' ? 'Android Native' : `${framework} (Android)`;
    } else if (fs.existsSync(path.join(resolvedPath, 'ios')) || fs.existsSync(path.join(resolvedPath, 'Podfile'))) {
      platform = 'mobile';
      framework = framework === 'Generic Web / Node' ? 'iOS Native' : `${framework} (iOS)`;
    }

    return {
      target: resolvedPath,
      targetType: 'directory',
      platform,
      framework,
      details,
      recommendations: {
        suggestedAdapters: platform === 'mobile' ? ['mobile-standard'] : ['web-standard'],
        suggestedPlan: `${framework} Automated Regression Suite`,
        viewports: platform === 'mobile' ? ['mobile-md', 'tablet'] : ['desktop', 'mobile-lg'],
      },
    };
  }

  // 3. Mobile package / Bundle ID
  if (/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)+$/.test(target)) {
    return {
      target,
      targetType: 'mobile_package',
      platform: 'mobile',
      framework: 'Mobile Application Bundle',
      details: { identifier: target },
      recommendations: {
        suggestedAdapters: ['mobile-standard'],
        suggestedPlan: 'Mobile Lifecycle & UI Exploration',
        viewports: ['mobile-md (375x667)', 'mobile-lg (390x844)'],
      },
    };
  }

  // 4. Default Fallback
  return {
    target,
    targetType: 'unknown',
    platform: configuredPlatform,
    details: { raw: target },
    recommendations: {
      suggestedAdapters: ['web-standard'],
      suggestedPlan: 'Universal Smoke Plan',
      viewports: ['desktop (1440x900)'],
    },
  };
}

export function registerInspectCommand(
  program: Command,
  getLogger: (isJson: boolean) => CliLogger
): void {
  program
    .command('inspect [target]')
    .description('Inspect target project directory, URL, or mobile package')
    .option('-t, --target <target>', 'Target to inspect')
    .option('-c, --config <path>', 'Configuration file path')
    .option('--json', 'Output machine-readable JSON')
    .action(async (targetArg: string | undefined, options: InspectOptions) => {
      const logger = getLogger(!!options.json);
      const target = targetArg || options.target;

      try {
        const result = await inspectTarget(target, options.config);

        if (options.json) {
          logger.json(result);
          process.exitCode = 0;
          return;
        }

        logger.log(pc.bold('\n🔎 QA Inspection Report\n'));
        logger.log(`Target:           ${pc.cyan(result.target)}`);
        logger.log(`Type:             ${result.targetType}`);
        logger.log(`Platform:         ${pc.green(result.platform.toUpperCase())}`);
        if (result.framework) {
          logger.log(`Framework:        ${result.framework}`);
        }
        if (result.reachable !== undefined) {
          logger.log(`Reachable:        ${result.reachable ? pc.green('YES') : pc.red('NO')}` + (result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''));
        }

        logger.log('\n' + pc.bold('Recommendations:'));
        logger.log(`  Suggested Adapters: ${result.recommendations.suggestedAdapters.join(', ')}`);
        logger.log(`  Suggested Plan:     ${result.recommendations.suggestedPlan}`);
        logger.log(`  Recommended Screens: ${result.recommendations.viewports.join(', ')}`);
        process.exitCode = 0;
      } catch (err: any) {
        if (options.json) {
          logger.json({ success: false, error: err.message });
        } else {
          logger.error(`\n✖ Inspection failed: ${err.message}`);
        }
        process.exitCode = 1;
      }
    });
}
