import fs from 'node:fs';
import path from 'node:path';
import { Platform } from '@agentic-qa/schemas';
import {
  InspectTargetInput,
  InspectTargetOutput,
  McpServerContext,
} from '../types.js';

export async function handleInspectTarget(
  input: InspectTargetInput,
  _context: McpServerContext
): Promise<InspectTargetOutput> {
  const { target, platform, timeoutMs = 10000 } = input;
  const isUrl = /^https?:\/\//i.test(target);

  if (isUrl) {
    return inspectUrlTarget(target, platform, timeoutMs);
  } else {
    return inspectLocalPathTarget(target, platform);
  }
}

async function inspectUrlTarget(
  targetUrl: string,
  platformOverride?: Platform,
  timeoutMs: number = 10000
): Promise<InspectTargetOutput> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'AgenticQA-Inspector/1.0.0',
        Accept: '*/*',
      },
    });

    const responseTimeMs = Date.now() - startTime;
    const contentType = res.headers.get('content-type') || '';
    const bodyText = await res.text();

    const frameworkHints: string[] = [];
    if (bodyText.includes('__NEXT_DATA__')) frameworkHints.push('Next.js');
    if (bodyText.includes('react') || bodyText.includes('id="root"')) frameworkHints.push('React');
    if (bodyText.includes('ng-version') || bodyText.includes('angular')) frameworkHints.push('Angular');
    if (bodyText.includes('data-v-') || bodyText.includes('vue')) frameworkHints.push('Vue');
    if (bodyText.includes('svelte')) frameworkHints.push('Svelte');
    if (res.headers.get('server')?.toLowerCase().includes('express')) frameworkHints.push('Express');

    // Extract page title if HTML
    let title: string | undefined;
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(bodyText);
    if (titleMatch) {
      title = titleMatch[1].trim();
    }

    const isJson = contentType.includes('application/json');
    const inferredPlatform: Platform = platformOverride || (isJson ? 'api' : 'web');

    const recommendations: string[] = [];
    if (inferredPlatform === 'web') {
      recommendations.push('Run smoke test with navigation and title assertion');
      recommendations.push('Evaluate accessibility (WCAG AA) violations on landing page');
      recommendations.push('Capture baseline visual screenshot for perceptual regression testing');
    } else if (inferredPlatform === 'api') {
      recommendations.push('Verify HTTP 200 response code and schema adherence');
      recommendations.push('Run endpoint fuzzing and status boundary checks');
    }

    return {
      target: targetUrl,
      inferredPlatform,
      targetType: 'URL',
      reachable: true,
      statusCode: res.status,
      contentType,
      responseTimeMs,
      frameworkHints,
      details: {
        title,
        contentLength: bodyText.length,
        headers: {
          server: res.headers.get('server'),
          cacheControl: res.headers.get('cache-control'),
        },
      },
      recommendations,
    };
  } catch (err: any) {
    const responseTimeMs = Date.now() - startTime;
    const errorMessage =
      err.name === 'AbortError'
        ? `Connection timed out after ${timeoutMs}ms`
        : `Target unreachable: ${err.message}`;

    return {
      target: targetUrl,
      inferredPlatform: platformOverride || 'web',
      targetType: 'URL',
      reachable: false,
      responseTimeMs,
      frameworkHints: [],
      details: {
        errorType: err.name,
      },
      recommendations: [
        'Ensure the target server is running and accessible from the current network',
        'Verify host and port configurations',
      ],
      error: errorMessage,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function inspectLocalPathTarget(
  targetPath: string,
  platformOverride?: Platform
): InspectTargetOutput {
  const resolved = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(process.cwd(), targetPath);

  if (!fs.existsSync(resolved)) {
    return {
      target: targetPath,
      inferredPlatform: platformOverride || 'web',
      targetType: 'UNKNOWN',
      reachable: false,
      frameworkHints: [],
      details: { resolvedPath: resolved },
      recommendations: ['Verify file or directory path exists on disk'],
      error: `Local path does not exist: ${resolved}`,
    };
  }

  const stat = fs.statSync(resolved);
  const isDir = stat.isDirectory();
  const ext = path.extname(resolved).toLowerCase();

  const frameworkHints: string[] = [];
  let inferredPlatform: Platform = platformOverride || 'web';

  if (isDir) {
    const pkgPath = path.join(resolved, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        if (deps.react) frameworkHints.push('React');
        if (deps.next) frameworkHints.push('Next.js');
        if (deps.vue) frameworkHints.push('Vue');
        if (deps.express) frameworkHints.push('Express');
        if (deps['react-native']) {
          frameworkHints.push('React Native');
          inferredPlatform = 'mobile';
        }
      } catch {
        // Ignore JSON read errors
      }
    }

    if (fs.existsSync(path.join(resolved, 'AndroidManifest.xml'))) {
      frameworkHints.push('Android Native');
      inferredPlatform = 'mobile';
    }

    if (fs.existsSync(path.join(resolved, 'index.html'))) {
      inferredPlatform = 'web';
    }
  } else {
    // Single file
    if (['.apk', '.aab', '.ipa'].includes(ext)) {
      inferredPlatform = 'mobile';
      frameworkHints.push(ext === '.apk' ? 'Android Package' : 'iOS App');
    } else if (['.exe', '.app', '.dmg'].includes(ext)) {
      inferredPlatform = 'desktop';
      frameworkHints.push('Desktop Binary');
    } else if (['.html', '.htm'].includes(ext)) {
      inferredPlatform = 'web';
    } else if (['.json', '.yaml', '.yml'].includes(ext)) {
      inferredPlatform = 'api';
    }
  }

  return {
    target: targetPath,
    inferredPlatform,
    targetType: isDir ? 'LOCAL_DIRECTORY' : 'LOCAL_FILE',
    reachable: true,
    frameworkHints,
    details: {
      resolvedPath: resolved,
      sizeBytes: stat.size,
      isDirectory: isDir,
      modifiedAt: stat.mtime.toISOString(),
    },
    recommendations: [
      `Generate ${inferredPlatform} test plan tailored for local target`,
      'Execute capability probe to ensure platform adapters are available',
    ],
  };
}
