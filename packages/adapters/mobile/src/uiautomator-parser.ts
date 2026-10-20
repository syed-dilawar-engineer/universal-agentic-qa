import { ElementBounds, UIElement } from './types.js';

export function parseBounds(boundsStr?: string): ElementBounds | undefined {
  if (!boundsStr) return undefined;
  const match = boundsStr.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!match) return undefined;

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

export function parseUIHierarchy(xml: string): UIElement[] {
  const elements: UIElement[] = [];
  if (!xml || typeof xml !== 'string') return elements;

  // Regex to extract all XML tags and their attributes
  const nodeTagRegex = /<([a-zA-Z0-9_\-\.:]+)\s+([^>]*?)(\/?>)/g;
  let match: RegExpExecArray | null;

  while ((match = nodeTagRegex.exec(xml)) !== null) {
    const tagName = match[1];
    const rawAttrs = match[2];

    const attributes: Record<string, string> = {};
    const attrRegex = /([a-zA-Z0-9_\-\.:]+)=(?:"([^"]*)"|'([^']*)')/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
      attributes[attrMatch[1]] = attrMatch[2] !== undefined ? attrMatch[2] : attrMatch[3] ?? '';
    }

    const bounds = parseBounds(attributes['bounds']);
    const enabled = attributes['enabled'] === 'true' || attributes['isEnabled'] === 'true';
    const clickable = attributes['clickable'] === 'true';
    const visible =
      attributes['visible-to-user'] !== 'false' &&
      attributes['displayed'] !== 'false' &&
      (bounds ? bounds.width > 0 && bounds.height > 0 : true);

    elements.push({
      tag: tagName,
      text: attributes['text'] || attributes['label'] || attributes['name'] || attributes['value'],
      resourceId: attributes['resource-id'] || attributes['identifier'] || attributes['id'],
      contentDesc: attributes['content-desc'] || attributes['accessibilityIdentifier'],
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
