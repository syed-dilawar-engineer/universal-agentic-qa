/**
 * Lightweight, robust DOM parser for static HTML accessibility & layout analysis.
 */

export interface ParsedElement {
  tagName: string;
  attributes: Record<string, string>;
  style: Record<string, string>;
  textContent: string;
  innerHTML: string;
  outerHTML: string;
  children: ParsedElement[];
  parent?: ParsedElement;
  depth: number;
}

/**
 * Parses inline CSS style string into key-value map.
 * E.g. "color: red; background-color: #fff; font-size: 16px"
 */
export function parseInlineStyle(styleAttr: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!styleAttr) return result;

  const declarations = styleAttr.split(';');
  for (const decl of declarations) {
    const colonIndex = decl.indexOf(':');
    if (colonIndex > 0) {
      const property = decl.slice(0, colonIndex).trim().toLowerCase();
      const value = decl.slice(colonIndex + 1).trim();
      if (property && value) {
        // Normalize camelCase and kebab-case
        result[property] = value;
        const camel = property.replace(/-([a-z])/g, (_, g) => g.toUpperCase());
        result[camel] = value;
      }
    }
  }

  return result;
}

/**
 * Parses an HTML attribute string into a dictionary.
 */
function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(attrString)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = value;
  }

  return attrs;
}

/**
 * Recursively parses HTML string into a tree of ParsedElements.
 */
export function parseHtml(html: string): ParsedElement[] {
  const rootElements: ParsedElement[] = [];
  const voidTags = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
  ]);

  // Strip comments
  const cleanHtml = html.replace(/<!--[\s\S]*?-->/g, '');

  const tagRegex = /<(\/)?([a-zA-Z0-9:-]+)([^>]*)>/g;
  const stack: ParsedElement[] = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(cleanHtml)) !== null) {
    const isClosing = Boolean(match[1]);
    const tagName = match[2].toLowerCase();
    const attrString = match[3];
    const startIndex = match.index;
    const fullTag = match[0];

    // Capture text before this tag
    if (stack.length > 0 && startIndex > lastIndex) {
      const textBetween = cleanHtml.slice(lastIndex, startIndex).trim();
      if (textBetween) {
        stack[stack.length - 1].textContent += ' ' + textBetween;
      }
    }

    lastIndex = tagRegex.lastIndex;

    if (isClosing) {
      // Find matching tag in stack
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tagName === tagName) {
          stack.splice(i);
          break;
        }
      }
    } else {
      const isSelfClosing = fullTag.endsWith('/>') || voidTags.has(tagName);
      const attributes = parseAttributes(attrString);
      const style = parseInlineStyle(attributes['style'] || '');

      const element: ParsedElement = {
        tagName,
        attributes,
        style,
        textContent: '',
        innerHTML: '',
        outerHTML: fullTag,
        children: [],
        parent: stack[stack.length - 1],
        depth: stack.length,
      };

      if (stack.length > 0) {
        stack[stack.length - 1].children.push(element);
      } else {
        rootElements.push(element);
      }

      if (!isSelfClosing) {
        stack.push(element);
      }
    }
  }

  return rootElements;
}

/**
 * Flattens all elements in a tree into an array.
 */
export function flattenElements(elements: ParsedElement[]): ParsedElement[] {
  const result: ParsedElement[] = [];
  const traverse = (el: ParsedElement) => {
    result.push(el);
    for (const child of el.children) {
      traverse(child);
    }
  };
  for (const root of elements) {
    traverse(root);
  }
  return result;
}

/**
 * Generates an informative CSS-like selector for a parsed element.
 */
export function getElementSelector(el: ParsedElement): string {
  let selector = el.tagName;
  if (el.attributes['id']) {
    return `#${el.attributes['id']}`;
  }
  if (el.attributes['class']) {
    const firstClass = el.attributes['class'].trim().split(/\s+/)[0];
    if (firstClass) {
      selector += `.${firstClass}`;
    }
  }
  if (el.attributes['name']) {
    selector += `[name="${el.attributes['name']}"]`;
  }
  if (el.attributes['role']) {
    selector += `[role="${el.attributes['role']}"]`;
  }

  if (el.parent && el.parent.tagName !== 'html' && el.parent.tagName !== 'body') {
    return `${getElementSelector(el.parent)} > ${selector}`;
  }

  return selector;
}
