import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { UmamiTracker } from '../../src/tracker';

// Only the disposable CI project is permitted: never point this at a deployment.
function compose(...args: string[]) {
  if (process.env.COMPOSE_PROJECT_NAME !== 'monkelytics-ci') {
    throw new Error('This test requires the disposable monkelytics-ci Compose project.');
  }
  return execFileSync('docker', ['compose', ...args], { encoding: 'utf8' }).trim();
}

function setServerTime(iso: string) {
  compose(
    'exec',
    '-T',
    'umami',
    'node',
    '-e',
    'const fs = require("node:fs"); const file = "/tmp/monkelytics-identity-clock"; fs.writeFileSync(file + ".next", process.argv[1]); fs.renameSync(file + ".next", file);',
    String(Date.parse(iso)),
  );
}

test('an open browser rotates at UTC midnight and persists both sessions in PostgreSQL', async ({
  page,
  request,
  baseURL,
}) => {
  const config = JSON.parse(compose('config', '--format', 'json'));
  expect(config.services.umami.environment.SALT_ROTATION).toBe('day');
  expect(config.services.umami.environment.TZ).toBe('America/New_York');
  expect(config.services.umami.environment.NODE_OPTIONS).toContain('server-clock.cjs');
  expect(
    Number(
      compose(
        'exec',
        '-T',
        'umami',
        'node',
        '-p',
        'new Date("2026-09-16T00:00:00Z").getTimezoneOffset()',
      ),
    ),
  ).toBe(240);

  let websiteId: string | undefined;
  let authorization: string;
  try {
    setServerTime('2026-09-15T23:59:59Z');
    const login = await request.post('/api/auth/login', {
      data: { username: 'admin', password: 'umami' },
    });
    expect(login.status()).toBe(200);
    authorization = `bearer ${(await login.json()).token}`;
    const created = await request.post('/api/websites', {
      headers: { authorization },
      data: { name: 'UTC rotation integration', domain: 'example.com' },
    });
    expect(created.status()).toBe(200);
    websiteId = (await created.json()).id;
    expect(websiteId).toMatch(/^[0-9a-f-]{36}$/);

    // Supply only the host page. The built tracker and collection endpoint are real.
    await page.route(`${baseURL}/identity-test`, route =>
      route.fulfill({
        contentType: 'text/html',
        body: `<html><head><title>Rotation test</title><script defer src="/script.js" data-website-id="${websiteId}" data-auto-track="false"></script></head><body>Rotation test</body></html>`,
      }),
    );
    await page.goto('/identity-test');
    await page.waitForFunction(() => !!(window as unknown as { umami: UmamiTracker }).umami);

    async function track(name: string, cachedToken?: string) {
      const responsePromise = page.waitForResponse(
        response => response.url().endsWith('/api/send') && response.request().method() === 'POST',
      );
      await page.evaluate(
        name => (window as unknown as { umami: UmamiTracker }).umami.track(name),
        name,
      );
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON().payload.timestamp).toBeUndefined();
      if (cachedToken) {
        expect(await response.request().headerValue('x-umami-cache')).toBe(cachedToken);
      }
      return response.json();
    }

    const first = await track('before-midnight');
    setServerTime('2026-09-16T00:00:00Z');
    const second = await track('after-midnight', first.cache);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.visitId).not.toBe(first.visitId);

    // New York midnight must not rotate the UTC-day visitor again.
    setServerTime('2026-09-16T04:00:00Z');
    const third = await track('local-midnight', second.cache);
    expect(third.sessionId).toBe(second.sessionId);

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
        `select json_agg(t) from (
        select e.session_id, e.visit_id, e.created_at, s.session_id as stored_session
        from website_event e join session s on s.session_id = e.session_id
        and s.website_id = e.website_id
        where e.website_id = '${websiteId}' order by e.created_at
      ) t`,
      ),
    );
    expect(rows).toHaveLength(3);
    for (const [index, result] of [first, second, third].entries()) {
      expect(rows[index].session_id).toBe(result.sessionId);
      expect(rows[index].stored_session).toBe(result.sessionId);
      expect(rows[index].visit_id).toBe(result.visitId);
    }
    expect(new Date(rows[0].created_at).toISOString()).toBe('2026-09-15T23:59:59.000Z');
    expect(new Date(rows[1].created_at).toISOString()).toBe('2026-09-16T00:00:00.000Z');
    expect(new Date(rows[2].created_at).toISOString()).toBe('2026-09-16T04:00:00.000Z');
  } finally {
    try {
      if (websiteId) {
        const deleted = await request.delete(`/api/websites/${websiteId}`, {
          headers: { authorization },
        });
        expect(deleted.status()).toBe(200);
      }
    } finally {
      compose('exec', '-T', 'umami', 'rm', '-f', '/tmp/monkelytics-identity-clock');
    }
  }
});
