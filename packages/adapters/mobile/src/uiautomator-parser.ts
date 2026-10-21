import { ElementBounds, UIElement } from './types.js';

export function decodeXmlEntities(str: string): string {
  if (!str) return str;
  return str.replace(/&(?:quot|apos|#39|#x27|lt|gt|amp);/g, (match) => {
    switch (match) {
      case '&quot;':
        return '"';
      case '&apos;':
      case '&#39;':
      case '&#x27;':
        return "'";
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      case '&amp;':
        return '&';
      default:
        return match;
    }
  });
}

function parseRectObject(obj: Record<string, any>): ElementBounds | undefined {
  if (
    obj.x !== undefined &&
    obj.y !== undefined &&
    obj.width !== undefined &&
    obj.height !== undefined
  ) {
    const left = parseFloat(String(obj.x));
    const top = parseFloat(String(obj.y));
    const width = Math.max(0, parseFloat(String(obj.width)));
    const height = Math.max(0, parseFloat(String(obj.height)));
    if (isNaN(left) || isNaN(top) || isNaN(width) || isNaN(height)) return undefined;
    const right = left + width;
    const bottom = top + height;
    const centerX = Math.round(left + width / 2);
    const centerY = Math.round(top + height / 2);
    return { left, top, right, bottom, centerX, centerY, width, height };
  }
  return undefined;
}

export function parseBounds(
  boundsInput?: string | Record<string, any>,
  rectAttrs?: Record<string, any>
): ElementBounds | undefined {
  if (!boundsInput && !rectAttrs) return undefined;

  // 1. Direct rect object support
  if (typeof boundsInput === 'object' && boundsInput !== null) {
    const res = parseRectObject(boundsInput);
    if (res) return res;
  }

  // 2. Android bounds string: [x1,y1][x2,y2]
  if (typeof boundsInput === 'string') {
    const match = boundsInput.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (match) {
      const left = parseInt(match[1], 10);
      const top = parseInt(match[2], 10);
      const right = parseInt(match[3], 10);
      const bottom = parseInt(match[4], 10);
      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);
      const centerX = Math.round(left + width / 2);
      const centerY = Math.round(top + height / 2);
      return { left, top, right, bottom, centerX, centerY, width, height };
    }

    // iOS/Appium rect string: x="0" y="0" width="100" height="200"
    const rectMatch = boundsInput.match(
      /(?:^|\s)x=["']?(-?\d+(?:\.\d+)?)["']?\s+y=["']?(-?\d+(?:\.\d+)?)["']?\s+width=["']?(-?\d+(?:\.\d+)?)["']?\s+height=["']?(-?\d+(?:\.\d+)?)["']?/
    );
    if (rectMatch) {
      return parseRectObject({
        x: rectMatch[1],
        y: rectMatch[2],
        width: rectMatch[3],
        height: rectMatch[4],
      });
    }

    // JSON rect string: {"x": 0, "y": 0, "width": 100, "height": 200}
    if (boundsInput.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(boundsInput);
        const res = parseRectObject(parsed);
        if (res) return res;
      } catch {
        // ignore
      }
    }
  }

  // 3. Fallback to rect attributes dictionary (e.g. from iOS/Appium XML attributes)
  if (rectAttrs && typeof rectAttrs === 'object') {
    const res = parseRectObject(rectAttrs);
    if (res) return res;
  }

  return undefined;
}

export function parseUIHierarchy(xml: string): UIElement[] {
  const elements: UIElement[] = [];
  if (!xml || typeof xml !== 'string') return elements;

  // Regex to extract all XML tags and their attributes safely without truncating on '>' inside quoted attributes
  const nodeTagRegex =
    /<([a-zA-Z0-9_\-\.:]+)((?:\s+[^"'\s>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>\/]+))?)*)\s*(\/?>)/g;
  let match: RegExpExecArray | null;

  while ((match = nodeTagRegex.exec(xml)) !== null) {
    const tagName = match[1];
    const rawAttrs = match[2];

    const attributes: Record<string, string> = {};
    const attrRegex = /([a-zA-Z0-9_\-\.:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
      const val = attrMatch[2] !== undefined ? attrMatch[2] : attrMatch[3] ?? '';
      attributes[attrMatch[1]] = decodeXmlEntities(val);
    }

    const bounds = parseBounds(attributes['bounds'], attributes);
    const enabled = attributes['enabled'] === 'true' || attributes['isEnabled'] === 'true';
    const clickable = attributes['clickable'] === 'true';
    const visible =
      attributes['visible-to-user'] !== 'false' &&
      attributes['displayed'] !== 'false' &&
      attributes['visible'] !== 'false' &&
      (bounds ? bounds.width > 0 && bounds.height > 0 : true);

    elements.push({
      tag: tagName,
      text: attributes['text'] || attributes['label'] || attributes['value'] || attributes['name'],
      resourceId: attributes['resource-id'] || attributes['identifier'] || attributes['id'],
      contentDesc:
        attributes['content-desc'] ||
        attributes['accessibilityIdentifier'] ||
        attributes['accessibility-id'],
      className: attributes['class'] || attributes['type'],
      packageName: attributes['package'],
      enabled,
      clickable,
      visible,
      bounds,
      attributes,
    });
  }

  return elements;
}

export function findElement(elements: UIElement[], selector: string): UIElement | undefined {
  if (!selector || elements.length === 0) return undefined;

  const trimmed = selector.trim();

  // 1. Direct coordinate format "x,y" or "@x,y"
  const coordMatch = trimmed.match(/^@?(-?\d+)\s*,\s*(-?\d+)$/);
  if (coordMatch) {
    const x = parseInt(coordMatch[1], 10);
    const y = parseInt(coordMatch[2], 10);
    return {
      tag: 'coordinate',
      enabled: true,
      clickable: true,
      visible: true,
      bounds: { left: x, top: y, right: x, bottom: y, centerX: x, centerY: y, width: 1, height: 1 },
      attributes: { x: String(x), y: String(y) },
    };
  }

  const findBest = (filter: (el: UIElement) => boolean): UIElement | undefined => {
    // Prefer visible elements
    const matched = elements.filter(filter);
    if (matched.length === 0) return undefined;
    const visible = matched.find((el) => el.visible);
    return visible || matched[0];
  };

  // 2. Explicit prefix selectors:
  // "id=login_btn" or "#login_btn"
  if (trimmed.startsWith('id=')) {
    const targetId = trimmed.slice(3).trim();
    return findBest(
      (el) =>
        el.resourceId === targetId ||
        Boolean(el.resourceId && el.resourceId.endsWith(`/${targetId}`)) ||
        Boolean(el.resourceId && el.resourceId.endsWith(`:id/${targetId}`))
    );
  }
  if (trimmed.startsWith('#')) {
    const targetId = trimmed.slice(1).trim();
    return findBest(
      (el) =>
        el.resourceId === targetId ||
        Boolean(el.resourceId && el.resourceId.endsWith(`/${targetId}`)) ||
        Boolean(el.resourceId && el.resourceId.endsWith(`:id/${targetId}`))
    );
  }

  // "text=Sign In"
  if (trimmed.startsWith('text=')) {
    const targetText = trimmed.slice(5).trim();
    return (
      findBest((el) => el.text === targetText) ||
      findBest((el) => el.text?.toLowerCase() === targetText.toLowerCase())
    );
  }

  // "desc=Submit" or "contentDesc=Submit"
  if (trimmed.startsWith('desc=')) {
    const targetDesc = trimmed.slice(5).trim();
    return findBest((el) => el.contentDesc === targetDesc);
  }
  if (trimmed.startsWith('contentDesc=')) {
    const targetDesc = trimmed.slice(12).trim();
    return findBest((el) => el.contentDesc === targetDesc);
  }

  // "accessibilityId=Submit" or "~Submit"
  if (trimmed.startsWith('accessibilityId=')) {
    const targetDesc = trimmed.slice(16).trim();
    return findBest(
      (el) =>
        el.contentDesc === targetDesc ||
        el.resourceId === targetDesc ||
        el.attributes['accessibilityIdentifier'] === targetDesc
    );
  }
  if (trimmed.startsWith('~')) {
    const targetDesc = trimmed.slice(1).trim();
    return findBest(
      (el) =>
        el.contentDesc === targetDesc ||
        el.resourceId === targetDesc ||
        el.attributes['accessibilityIdentifier'] === targetDesc
    );
  }

  // "class=android.widget.Button" or "type=XCUIElementTypeButton"
  if (trimmed.startsWith('class=')) {
    const targetClass = trimmed.slice(6).trim();
    return findBest((el) => el.className === targetClass || el.tag === targetClass);
  }
  if (trimmed.startsWith('type=')) {
    const targetClass = trimmed.slice(5).trim();
    return findBest((el) => el.className === targetClass || el.tag === targetClass);
  }

  // "name=Submit" or "label=Submit"
  if (trimmed.startsWith('name=')) {
    const targetName = trimmed.slice(5).trim();
    return findBest((el) => el.text === targetName || el.attributes['name'] === targetName);
  }
  if (trimmed.startsWith('label=')) {
    const targetLabel = trimmed.slice(6).trim();
    return findBest((el) => el.text === targetLabel || el.attributes['label'] === targetLabel);
  }

  // 3. Fallback: match by resourceId, text, contentDesc, or name
  return findBest(
    (el) =>
      el.resourceId === trimmed ||
      Boolean(el.resourceId && el.resourceId.endsWith(`:id/${trimmed}`)) ||
      Boolean(el.resourceId && el.resourceId.endsWith(`/${trimmed}`)) ||
      el.text === trimmed ||
      el.contentDesc === trimmed ||
      el.attributes['name'] === trimmed ||
      el.attributes['label'] === trimmed ||
      Boolean(el.text && el.text.toLowerCase() === trimmed.toLowerCase())
  );
}
