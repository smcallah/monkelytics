import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { register } from '../instrumentation';
import { getTrackingPlan, loadTrackingPlans, reportTrackingIssues } from './tracking-plan';

const site = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'monkelytics-plan-'));
  Reflect.deleteProperty(globalThis, '__monkelyticsTrackingPlan');
  vi.stubEnv('ANALYTICS_MANIFEST_PATH', undefined);
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, '__monkelyticsTrackingPlan');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
  expect(directory).toContain('monkelytics-plan-');
  rmSync(directory, { recursive: true, force: true });
});

test('unconfigured collection requires no file and has no site policy', () => {
  expect(loadTrackingPlans()).toBeUndefined();
  expect(getTrackingPlan(site)).toBeUndefined();
});
test('loads an exact per-site assignment and holds it until process restart', () => {
  const file = join(directory, 'analytics.yaml');
  writeFileSync(
    file,
    `version: 1\nwebsites:\n  ${site}:\n    mode: reject\n    events:\n      button: {}`,
  );
  vi.stubEnv('ANALYTICS_MANIFEST_PATH', file);
  register();
  expect(getTrackingPlan(site).mode).toBe('reject');
  expect(getTrackingPlan(site.toUpperCase()).mode).toBe('reject');
  expect(getTrackingPlan('22222222-2222-4222-8222-222222222222')).toBeUndefined();
  writeFileSync(file, 'invalid');
  expect(getTrackingPlan(site).mode).toBe('reject');
  Reflect.deleteProperty(globalThis, '__monkelyticsTrackingPlan');
  expect(() => loadTrackingPlans()).toThrow(/analytics.yaml:\d+:\d+:/);
});
test.each(['missing.yaml', '.', 'invalid.yaml', 'large.yaml'])(
  'configured %s fails startup instead of silently disabling validation',
  file => {
    writeFileSync(join(directory, 'invalid.yaml'), 'version: 2\nwebsites: {}');
    writeFileSync(join(directory, 'large.yaml'), ' '.repeat(256 * 1024 + 1));
    vi.stubEnv('ANALYTICS_MANIFEST_PATH', join(directory, file));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('stopped');
    });
    expect(() => register()).toThrow('stopped');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(loadTrackingPlans).toThrow();
  },
);
test('loads the repository example without enabling it implicitly', () => {
  expect(loadTrackingPlans()).toBeUndefined();
  expect(readFileSync('analytics.yaml', 'utf8')).toContain('mode: observe');
});

test('reports each drift code once per site and snapshot without logging property names or values', () => {
  const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const issues = [{ code: 'undeclared_property' as const, property: 'private_property' }];
  reportTrackingIssues(site, issues);
  reportTrackingIssues(site.toUpperCase(), issues);
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith('Tracking plan mismatch', {
    websiteId: site,
    codes: ['undeclared_property'],
  });
  reportTrackingIssues(site, [{ code: 'missing_property' }]);
  expect(diagnostic).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private_property');
});
