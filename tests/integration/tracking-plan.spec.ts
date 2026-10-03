import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import ts from 'typescript';
import { generateAnalyticsHelper } from '../../src/lib/analytics-codegen';
import { parseAnalyticsManifest } from '../../src/lib/analytics-manifest';
import type { UmamiTracker } from '../../src/tracker';

const observe = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const reject = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const dynamic = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function compose(...args: string[]) {
  if (process.env.COMPOSE_PROJECT_NAME !== 'monkelytics-ci') {
    throw new Error('This test requires the disposable monkelytics-ci Compose project.');
  }
  return execFileSync('docker', ['compose', ...args], { encoding: 'utf8' }).trim();
}

test('tracking plans isolate websites, preserve observe traffic, and reject drift before PostgreSQL writes', async ({
  page,
  request,
  baseURL,
}) => {
  test.skip(
    process.env.TRACKING_PLAN_TEST !== 'enabled',
    'Requires the optional manifest overlay.',
  );
  const config = JSON.parse(compose('config', '--format', 'json'));
  expect(config.services.umami.environment.ANALYTICS_MANIFEST_PATH).toBe(
    '/tracking-plan/analytics.yaml',
  );
  const websiteIds: string[] = [];
  let authorization: string;
  try {
    const login = await request.post('/api/auth/login', {
      data: { username: 'admin', password: 'umami' },
    });
    expect(login.status()).toBe(200);
    authorization = `bearer ${(await login.json()).token}`;
    for (const [id, name] of [
      [observe, 'Observe plan'],
      [reject, 'Reject plan'],
      [dynamic, 'Unconfigured dynamic'],
    ]) {
      const created = await request.post('/api/websites', {
        headers: { authorization },
        data: { id, name, domain: 'example.com' },
      });
      expect(created.status()).toBe(200);
      expect((await created.json()).id).toBe(id);
      websiteIds.push(id);
    }

    const manifest = parseAnalyticsManifest(
      readFileSync('tests/integration/analytics.yaml', 'utf8'),
    );
    const helper = ts.transpileModule(generateAnalyticsHelper(manifest, reject), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    await page.route(`${baseURL}/plan-test`, route =>
      route.fulfill({
        contentType: 'text/html',
        body: `<html><head><script defer src="/script.js" data-website-id="${reject}" data-auto-track="false"></script></head><body>Tracking plan test</body></html>`,
      }),
    );
    await page.goto('/plan-test');
    await page.waitForFunction(() => !!(window as unknown as { umami: UmamiTracker }).umami);
    await page.addScriptTag({
      type: 'module',
      content: `${helper}\nwindow.trackPlanned = createAnalytics(window.umami);`,
    });
    await page.waitForFunction(
      () => !!(window as unknown as { trackPlanned: unknown }).trackPlanned,
    );
    const wait = () =>
      page.waitForResponse(
        res => res.url().endsWith('/api/send') && res.request().method() === 'POST',
      );
    let pending = wait();
    await page.evaluate(() =>
      (
        window as unknown as { trackPlanned: (name: string, data: object) => Promise<void> }
      ).trackPlanned('button', { button: 'sample', count: 1 }),
    );
    const valid = await pending;
    expect(valid.status()).toBe(200);
    expect(valid.request().postDataJSON().payload.website).toBe(reject);
    expect(new URL(valid.request().postDataJSON().payload.url).pathname).toBe('/plan-test');
    expect(valid.request().postDataJSON().payload.screen).toMatch(/^\d+x\d+$/);
    const cache = (await valid.json()).cache;
    pending = wait();
    await page.evaluate(() =>
      (window as unknown as { umami: UmamiTracker }).umami.track('undeclared'),
    );
    const invalid = await pending;
    expect(invalid.status()).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { validation: { mode: 'reject', issues: [{ code: 'undeclared_event' }] } },
    });

    const send = (
      website: string,
      name?: string,
      data?: object,
      type = 'event',
      headers?: Record<string, string>,
    ) =>
      request.post('/api/send', {
        headers,
        data: {
          type,
          payload: { website, url: '/direct', ...(name && { name }), ...(data && { data }) },
        },
      });
    const observed = await send(observe, 'private-event-name', {
      private_property: 'private-test-value',
    });
    expect(observed.status()).toBe(200);
    expect(await observed.json()).toMatchObject({
      validation: { mode: 'observe', issues: [{ code: 'undeclared_event' }] },
    });
    const properties = await send(observe, 'button', { button: 1, unknown: 'private-test-value' });
    expect(properties.status()).toBe(200);
    expect(await properties.json()).toMatchObject({
      validation: {
        mode: 'observe',
        issues: [
          { code: 'undeclared_property', property: 'unknown' },
          { code: 'invalid_type', property: 'button' },
        ],
      },
    });
    const rejected = await send(reject, 'button', {}, 'event', { 'x-umami-cache': cache });
    expect(rejected.status()).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: { validation: { issues: [{ code: 'missing_property', property: 'button' }] } },
    });
    const uppercase = await send(reject.toUpperCase(), 'button', { button: false });
    expect(uppercase.status()).toBe(400);
    expect(await uppercase.json()).toMatchObject({ error: { validation: { mode: 'reject' } } });
    const unconfigured = await send(dynamic, 'undeclared', { arbitrary: ['still', 'supported'] });
    expect(unconfigured.status()).toBe(200);
    expect(await unconfigured.json()).not.toHaveProperty('validation');
    expect((await send(reject)).status()).toBe(200);
    expect((await send(reject, 'ignored', undefined, 'performance')).status()).toBe(200);

    const batch = await request.post('/api/batch', {
      data: [
        {
          type: 'event',
          payload: { website: reject, url: '/batch', name: 'button', data: { button: 'batch' } },
        },
        { type: 'event', payload: { website: reject, url: '/batch', name: 'undeclared' } },
        { type: 'event', payload: { website: observe, url: '/batch', name: 'undeclared' } },
      ],
    });
    expect(batch.status()).toBe(200);
    expect(await batch.json()).toMatchObject({
      size: 3,
      processed: 2,
      errors: 1,
      details: [{ index: 1, response: { error: { validation: { mode: 'reject' } } } }],
      validations: [
        { index: 2, validation: { mode: 'observe', issues: [{ code: 'undeclared_event' }] } },
      ],
    });
    const rows = JSON.parse(
      compose(
        'exec',
        '-T',
        'db',
        'psql',
        '-U',
        'umami',
        '-d',
        'umami',
        '-At',
        '-c',
        `select json_agg(t) from (select website_id, count(*) as events from website_event where website_id in ('${observe}', '${reject}', '${dynamic}') group by website_id order by website_id) t`,
      ),
    );
    expect(rows).toEqual([
      { website_id: observe, events: 3 },
      { website_id: reject, events: 4 },
      { website_id: dynamic, events: 1 },
    ]);
    const stored = JSON.parse(
      compose(
        'exec',
        '-T',
        'db',
        'psql',
        '-U',
        'umami',
        '-d',
        'umami',
        '-At',
        '-c',
        `select json_agg(t) from (select e.event_name, d.data_key, d.string_value from website_event e join event_data d on e.event_id = d.website_event_id where e.website_id = '${observe}' order by d.data_key) t`,
      ),
    );
    expect(stored).toContainEqual({
      event_name: 'private-event-name',
      data_key: 'private_property',
      string_value: 'private-test-value',
    });
    const logs = compose('logs', '--no-color', 'umami');
    expect(logs).toContain('Tracking plan mismatch');
    expect(logs).not.toContain('private-event-name');
    expect(logs).not.toContain('private-test-value');
    expect(logs).not.toContain('private_property');
  } finally {
    for (const websiteId of websiteIds) {
      const deleted = await request.delete(`/api/websites/${websiteId}`, {
        headers: { authorization },
      });
      expect(deleted.status()).toBe(200);
    }
  }
});
