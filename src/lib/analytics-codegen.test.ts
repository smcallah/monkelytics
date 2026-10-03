import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { generateAnalyticsHelper } from './analytics-codegen';
import { parseAnalyticsManifest } from './analytics-manifest';

const site = '11111111-1111-4111-8111-111111111111';
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'monkelytics-codegen-'));
});
afterEach(() => {
  expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
  expect(directory).toContain('monkelytics-codegen-');
  rmSync(directory, { recursive: true, force: true });
});
const source = `version: 1
websites:
  ${site}:
    events:
      purchase:
        properties:
          revenue: {type: number, required: true}
          currency: {type: string, required: true}
          returning: {type: boolean}
      empty: {}
      optional:
        properties:
          count: {type: number}
`;

test('generated types accept the real tracker and reject mismatched events/properties', () => {
  const helper = join(directory, 'analytics.ts');
  writeFileSync(helper, generateAnalyticsHelper(parseAnalyticsManifest(source), site));
  const fixture = join(directory, 'consumer.ts');
  writeFileSync(
    fixture,
    `
import { createAnalytics } from './analytics';
import type { UmamiTracker } from ${JSON.stringify(resolve('src/tracker/index.ts').replaceAll('\\', '/'))};
declare const tracker: UmamiTracker;
const track = createAnalytics(tracker);
track('purchase', { revenue: 1, currency: 'USD' });
track('purchase', { revenue: 0, currency: 'USD', returning: false });
track('empty');
track('optional');
track('optional', { count: 1 });
// @ts-expect-error Undeclared event
track('missing');
// @ts-expect-error Required data
track('purchase');
// @ts-expect-error Wrong type
track('purchase', { revenue: '1', currency: 'USD' });
// @ts-expect-error Required property
track('purchase', { revenue: 1 });
// @ts-expect-error Undeclared property
track('purchase', { revenue: 1, currency: 'USD', secret: 'private' });
// @ts-expect-error Empty events have no properties
track('empty', { secret: 'private' });
// @ts-expect-error The optional schema cannot widen a literal purchase event
track('purchase', { count: 1 });
declare const ambiguous: 'purchase' | 'empty';
// @ts-expect-error Narrow an ambiguous event before omitting required data
track(ambiguous);
`,
  );
  const program = ts.createProgram([fixture, helper], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    types: [],
    allowImportingTsExtensions: true,
  });
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
  ).toEqual([]);
}, 30_000);

test('generated helper binds the website ID and sends through the existing tracker', async () => {
  const output = ts.transpileModule(generateAnalyticsHelper(parseAnalyticsManifest(source), site), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports: {
    createAnalytics?: (tracker: {
      track: typeof send;
    }) => (name: string, data?: object) => Promise<void>;
  } = {};
  const payloads: object[] = [];
  const context = {
    website: 'existing-tracker-site',
    url: '/current-page',
    title: 'Current page',
    screen: '1920x1080',
    language: 'en-US',
  };
  const send = vi.fn(async (callback: (payload: typeof context) => object) => {
    payloads.push(callback(context));
  });
  new Function('exports', output.outputText)(exports);
  const track = exports.createAnalytics({ track: send });
  await track('purchase', { revenue: 1, currency: 'USD' });
  await track('empty');
  expect(payloads[0]).toEqual({
    ...context,
    website: site,
    name: 'purchase',
    data: { revenue: 1, currency: 'USD' },
  });
  expect(payloads[1]).toEqual({ ...context, website: site, name: 'empty' });
});

test('generation is deterministic and rejects websites absent from the manifest', () => {
  const manifest = parseAnalyticsManifest(source);
  const first = generateAnalyticsHelper(manifest, site);
  manifest.websites[site].events = Object.fromEntries(
    Object.entries(manifest.websites[site].events).reverse(),
  );
  expect(generateAnalyticsHelper(manifest, site)).toBe(first);
  expect(() => generateAnalyticsHelper(manifest, '22222222-2222-4222-8222-222222222222')).toThrow(
    'not declared',
  );
});

function cli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'scripts/analytics-manifest.ts', ...args],
    {
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
}

test('CLI validates, generates, checks drift and leaves inputs/output intact on errors', () => {
  const file = join(directory, 'analytics.yaml');
  const output = join(directory, 'helper.ts');
  writeFileSync(file, source);
  expect(cli('validate', file).status).toBe(0);
  expect(cli('generate', file, '--website-id', site, '--out', output).status).toBe(0);
  const helper = readFileSync(output, 'utf8');
  expect(readFileSync(file, 'utf8')).toBe(source);
  expect(cli('check', file, '--website-id', site, '--out', output).status).toBe(0);
  writeFileSync(output, helper.replaceAll('\n', '\r\n'));
  expect(cli('check', file, '--website-id', site, '--out', output).status).toBe(0);
  writeFileSync(file, source.replace('type: number', 'type: string'));
  const stale = cli('check', file, '--website-id', site, '--out', output);
  expect(stale.status).toBe(1);
  expect(stale.stderr).toContain('out of date');
  writeFileSync(file, source.replace('version: 1', 'version: 2'));
  const invalid = cli('generate', file, '--website-id', site, '--out', output);
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toMatch(/analytics.yaml:1:10:/);
  expect(readFileSync(output, 'utf8')).toBe(helper.replaceAll('\n', '\r\n'));
}, 30_000);

test.each([
  ['validate', 'analytics.yaml', '--out', 'other.ts'],
  ['generate', 'analytics.yaml'],
  ['generate', 'analytics.yaml', '--website-id', site, '--out', 'analytics.yaml'],
  ['generate', 'analytics.yaml', '--website-id', site, '--website-id', site, '--out', 'other.ts'],
  ['unknown', 'analytics.yaml'],
])('CLI fails invalid arguments instead of writing: %j', (...args) => {
  expect(cli(...args).status).toBe(1);
});
