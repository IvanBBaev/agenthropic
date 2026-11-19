/**
 * UX-18 - the palette is a set of custom properties on :root, so a light theme
 * is one override block instead of a hunt through the stylesheet. These pin
 * that: a colour literal added to a rule outside :root would quietly make the
 * next theme incomplete, and a var() naming a property nobody defined renders
 * as the inherited colour with no error anywhere.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src', 'styles.css'), 'utf8');
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const rootMatch = /:root\s*\{([^}]*)\}/.exec(withoutComments);
const rootBody = rootMatch?.[1] ?? '';
const rules = withoutComments.replace(/:root\s*\{[^}]*\}/, '');

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;

function definedProperties(): Map<string, string> {
  const defined = new Map<string, string>();
  for (const match of rootBody.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    defined.set(match[1] as string, (match[2] as string).trim());
  }
  return defined;
}

describe('the stylesheet palette (UX-18)', () => {
  it('declares the palette on a single :root block', () => {
    expect(rootMatch).not.toBeNull();
    expect(withoutComments.match(/:root\s*\{/g)).toHaveLength(1);
    expect(definedProperties().size).toBeGreaterThan(30);
  });

  it('keeps every colour literal inside :root', () => {
    expect(rules.match(COLOUR_LITERAL) ?? []).toEqual([]);
  });

  it('uses only custom properties that :root defines', () => {
    const defined = definedProperties();
    const used = [...withoutComments.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(100);
    expect(used.filter((name) => !defined.has(name as string))).toEqual([]);
  });

  it('paints `waiting` grey, as ux0 specifies, the same grey as the waiting chip', () => {
    const defined = definedProperties();
    expect(defined.get('--status-waiting')).toBe('var(--text-muted)');
    expect(rules).toMatch(/\.status-waiting\s*\{\s*color:\s*var\(--status-waiting\);/);
    expect(rules).toMatch(/\.chip-wait\s*\{\s*color:\s*var\(--status-waiting\);/);
  });
});
