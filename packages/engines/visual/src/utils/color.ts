/**
 * Color and luminance utilities for WCAG 2.1 AA accessibility audits.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED_COLORS: Record<string, RGBA> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  yellow: { r: 255, g: 255, b: 0, a: 1 },
  cyan: { r: 0, g: 255, b: 255, a: 1 },
  magenta: { r: 255, g: 0, b: 255, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  lightgray: { r: 211, g: 211, b: 211, a: 1 },
  lightgrey: { r: 211, g: 211, b: 211, a: 1 },
  darkgray: { r: 169, g: 169, b: 169, a: 1 },
  darkgrey: { r: 169, g: 169, b: 169, a: 1 },
  silver: { r: 192, g: 192, b: 192, a: 1 },
  orange: { r: 255, g: 165, b: 0, a: 1 },
  purple: { r: 128, g: 0, b: 128, a: 1 },
  navy: { r: 0, g: 0, b: 128, a: 1 },
  teal: { r: 0, g: 128, b: 128, a: 1 },
  maroon: { r: 128, g: 0, b: 0, a: 1 },
  olive: { r: 128, g: 128, b: 0, a: 1 },
  lime: { r: 0, g: 255, b: 0, a: 1 },
  aqua: { r: 0, g: 255, b: 255, a: 1 },
  fuchsia: { r: 255, g: 0, b: 255, a: 1 },
};

/**
 * Parses CSS color string into RGBA components (0-255 for RGB, 0-1 for Alpha).
 */
export function parseColor(colorStr: string): RGBA | null {
  if (!colorStr) return null;
  const str = colorStr.trim().toLowerCase();

  if (NAMED_COLORS[str]) {
    return { ...NAMED_COLORS[str] };
  }

  // Hex format: #fff, #ffffff, #ffffffff
  if (str.startsWith('#')) {
    const hex = str.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: 1,
      };
    }
    if (hex.length === 4) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: parseInt(hex[3] + hex[3], 16) / 255,
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
    return null;
  }

  // rgb(...) or rgba(...)
  const rgbMatch = str.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (rgbMatch) {
    return {
      r: Math.min(255, Math.max(0, parseInt(rgbMatch[1], 10))),
      g: Math.min(255, Math.max(0, parseInt(rgbMatch[2], 10))),
      b: Math.min(255, Math.max(0, parseInt(rgbMatch[3], 10))),
      a: rgbMatch[4] !== undefined ? Math.min(1, Math.max(0, parseFloat(rgbMatch[4]))) : 1,
    };
  }

  // hsl(...) or hsla(...)
  const hslMatch = str.match(/^hsla?\s*\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (hslMatch) {
    const h = parseInt(hslMatch[1], 10) / 360;
    const s = parseInt(hslMatch[2], 10) / 100;
    const l = parseInt(hslMatch[3], 10) / 100;
    const a = hslMatch[4] !== undefined ? parseFloat(hslMatch[4]) : 1;

    let r: number, g: number, b: number;
    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255),
      a: Math.min(1, Math.max(0, a)),
    };
  }

  return null;
}

/**
 * Calculates relative luminance for an sRGB color per WCAG 2.1 specs.
 * See: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function calculateRelativeLuminance(rgb: RGBA): number {
  const normalize = (val: number) => {
    const s = val / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };

  const r = normalize(rgb.r);
  const g = normalize(rgb.g);
  const b = normalize(rgb.b);

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Calculates contrast ratio between two colors per WCAG 2.1 specs.
 * Result is in the range 1.0 to 21.0 (e.g. 4.5 for 4.5:1).
 */
export function calculateContrastRatio(fg: RGBA, bg: RGBA): number {
  // If foreground has alpha < 1, blend with background
  const blendedFg: RGBA = {
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  };

  const lum1 = calculateRelativeLuminance(blendedFg);
  const lum2 = calculateRelativeLuminance(bg);

  const l1 = Math.max(lum1, lum2);
  const l2 = Math.min(lum1, lum2);

  return (l1 + 0.05) / (l2 + 0.05);
}

/**
 * Verifies if contrast ratio meets WCAG 2.1 AA requirements.
 * - Normal text: 4.5:1
 * - Large text (>= 18pt or >= 14pt bold): 3.0:1
 * - UI components / non-text: 3.0:1
 */
export function isContrastSufficient(
  contrastRatio: number,
  options: { isLargeText?: boolean; isUiComponent?: boolean } = {}
): boolean {
  const minRequired = options.isLargeText || options.isUiComponent ? 3.0 : 4.5;
  return contrastRatio >= minRequired;
}
