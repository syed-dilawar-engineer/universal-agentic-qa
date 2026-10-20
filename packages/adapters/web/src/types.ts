import { Platform, EvidenceArtifact } from '@agentic-qa/schemas';
import type { Browser, BrowserContext, Page, LaunchOptions, BrowserContextOptions } from 'playwright';

/**
 * Standard Viewport Matrix supported by the WebAdapter.
 * Matches common responsive testing breakpoints:
 * - 320: Mobile XS (e.g. iPhone SE)
 * - 360: Mobile SM (e.g. Android Standard / Galaxy S8)
 * - 390: Mobile MD (e.g. iPhone 12/13/14)
 * - 768: Tablet Portrait (e.g. iPad)
 * - 1024: Tablet Landscape / Small Desktop
 * - 1440: Desktop Standard / Hi-DPI
 */
export const VIEWPORT_MATRIX: Record<number, { width: number; height: number }> = {
  320: { width: 320, height: 568 },
  360: { width: 360, height: 640 },
  390: { width: 390, height: 844 },
  768: { width: 768, height: 1024 },
  1024: { width: 1024, height: 768 },
  1440: { width: 1440, height: 900 },
};

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export interface ViewportDimensions {
  width: number;
  height: number;
}

export interface WebAdapterOptions {
  id?: string;
  name?: string;
  browserType?: BrowserName;
  headless?: boolean;
  viewport?: ViewportDimensions | number | string;
  viewportWidth?: number;
  outputDir?: string;
  baseURL?: string;
  launchOptions?: LaunchOptions;
  contextOptions?: BrowserContextOptions;
  /**
   * Optional custom mock/injected objects for unit testing in headless or sandboxed environments
   */
  customBrowser?: Browser | any;
  customContext?: BrowserContext | any;
  customPage?: Page | any;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  location?: string;
  timestamp: string;
}

export interface NetworkFailureEntry {
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  errorText?: string;
  timestamp: string;
}

export interface NetworkRequestEntry {
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  timestamp: string;
}

export type LayoutIssueType = 'HORIZONTAL_OVERFLOW' | 'CLIPPED_ELEMENT' | 'OFFSCREEN_CONTROL';

export interface LayoutIssue {
  type: LayoutIssueType;
  selector?: string;
  tagName: string;
  details: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface LayoutCheckResult {
  hasIssues: boolean;
  horizontalOverflow: boolean;
  issues: LayoutIssue[];
  metrics: {
    clientWidth: number;
    scrollWidth: number;
    clientHeight: number;
    scrollHeight: number;
  };
}

/**
 * Resolves a viewport configuration into concrete width and height.
 */
export function resolveViewport(
  viewport?: ViewportDimensions | number | string,
  viewportWidth?: number
): ViewportDimensions {
  if (typeof viewportWidth === 'number') {
    return VIEWPORT_MATRIX[viewportWidth] || { width: viewportWidth, height: 800 };
  }

  if (typeof viewport === 'number') {
    return VIEWPORT_MATRIX[viewport] || { width: viewport, height: 800 };
  }

  if (typeof viewport === 'string') {
    const num = parseInt(viewport, 10);
    if (!isNaN(num) && VIEWPORT_MATRIX[num]) {
      return VIEWPORT_MATRIX[num];
    }
    const namedMap: Record<string, ViewportDimensions> = {
      'mobile-sm': { width: 320, height: 568 },
      'mobile-md': { width: 360, height: 640 },
      'mobile-lg': { width: 390, height: 844 },
      'tablet': { width: 768, height: 1024 },
      'desktop': { width: 1440, height: 900 },
    };
    if (namedMap[viewport]) {
      return namedMap[viewport];
    }
  }

  if (typeof viewport === 'object' && viewport !== null) {
    const width = Number(viewport.width) || 1440;
    const height = Number(viewport.height) || (VIEWPORT_MATRIX[width]?.height ?? 900);
    return { width, height };
  }

  return VIEWPORT_MATRIX[1440];
}
