import { describe, expect, test } from 'vitest';
import { parseAnalyticsManifest, validatePlannedEvent } from './analytics-manifest';

const site = '11111111-1111-4111-8111-111111111111';
const source = `version: 1
websites:
  ${site}:
    events:
      purchase:
        properties:
          revenue:
            type: number
            required: true
          currency:
            type: string
            required: true
          returning:
            type: boolean
      empty: {}
`;

describe('analytics manifest format', () => {
  test('defaults to observation, preserves scalar types and optional properties', () => {
    const plan = parseAnalyticsManifest(source).websites[site];
    expect(plan.mode).toBe('observe');
    expect(plan.events.purchase.properties.returning).toEqual({ type: 'boolean', required: false });
    expect(plan.events.empty.properties).toEqual({});
  });
  test.each([
    ['', 'manifest'],
    [source.replace('version: 1', 'version: 2'), 'version'],
    [source.replace(site, 'not-a-uuid'), 'lowercase UUID'],
    [source.replace('type: number', 'type: object'), 'type'],
    [source.replace('type: number', 'type: number\n            misspelled: true'), 'misspelled'],
    [source.replace('required: true', 'required: yes'), 'required'],
    [source.replace('    events:', '    mode: strict\n    events:'), 'mode'],
    [source.replace('revenue:', '__proto__:'), 'Reserved property'],
    [source.replace('purchase:', 'constructor:'), 'Reserved property or event'],
    [source.replace('purchase:', 'purchase!:'), 'events'],
    [source.replace('version: 1', 'version: 1\nversion: 1'), 'unique'],
    [`${source}---\nversion: 1\nwebsites: {}`, 'document'],
    ['version: 1\nwebsites: &sites {}\nother: *sites', 'aliases'],
    [source.replace('type: number', 'type: !custom number'), 'tag'],
  ])('rejects invalid input with filename and position: %j', (text, reason) => {
    expect(() => parseAnalyticsManifest(text, 'plan.yaml')).toThrow(/plan.yaml:\d+:\d+:/);
    expect(() => parseAnalyticsManifest(text)).toThrow(new RegExp(reason, 'i'));
  });
  test('semantic diagnostics point at the invalid field', () => {
    expect(() =>
      parseAnalyticsManifest(source.replace('type: number', 'type: invalid'), 'plan.yaml'),
    ).toThrow('plan.yaml:8:19:');
  });
  test('allows removing all assignments without changing unconfigured websites', () => {
    expect(parseAnalyticsManifest('version: 1\nwebsites: {}').websites).toEqual({});
  });
  test('bounds input size', () => {
    expect(() => parseAnalyticsManifest(' '.repeat(256 * 1024 + 1))).toThrow('exceeds');
  });
});

describe('declared events', () => {
  const plan = parseAnalyticsManifest(source).websites[site];
  test('accepts required and optional scalar properties without mutating data', () => {
    const data = Object.freeze({ revenue: 12.5, currency: 'USD', returning: false });
    expect(validatePlannedEvent(plan, 'purchase', data)).toEqual([]);
    expect(validatePlannedEvent(plan, 'purchase', { revenue: 0, currency: '' })).toEqual([]);
    expect(validatePlannedEvent(plan, 'empty')).toEqual([]);
  });
  test('reports missing, undeclared and wrongly typed properties without values', () => {
    const issues = validatePlannedEvent(plan, 'purchase', {
      revenue: 'private-value',
      unknown: '203.0.113.5',
      returning: null,
    });
    expect(issues).toEqual([
      { code: 'undeclared_property', property: 'unknown' },
      { code: 'invalid_type', property: 'revenue' },
      { code: 'missing_property', property: 'currency' },
      { code: 'invalid_type', property: 'returning' },
    ]);
    expect(JSON.stringify(issues)).not.toContain('private-value');
    expect(JSON.stringify(issues)).not.toContain('203.0.113.5');
  });
  test.each([NaN, Infinity, {}, [], null, true])('rejects invalid number %j', value => {
    expect(
      validatePlannedEvent(plan, 'purchase', { revenue: value, currency: 'USD' }),
    ).toContainEqual({ code: 'invalid_type', property: 'revenue' });
  });
  test('does not count inherited values as required properties or declarations', () => {
    expect(validatePlannedEvent(plan, 'toString')).toEqual([{ code: 'undeclared_event' }]);
    expect(
      validatePlannedEvent(plan, 'purchase', Object.create({ revenue: 1, currency: 'USD' })),
    ).toHaveLength(2);
  });
  test('reports strings exceeding the existing storage limit', () => {
    expect(
      validatePlannedEvent(plan, 'purchase', { revenue: 1, currency: 'x'.repeat(501) }),
    ).toEqual([{ code: 'too_long', property: 'currency' }]);
  });
});
