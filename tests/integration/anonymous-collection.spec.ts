import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { UmamiTracker } from '../../src/tracker';

function compose(...args: string[]) {
  if (process.env.COMPOSE_PROJECT_NAME !== 'monkelytics-ci') {
    throw new Error('This test requires the disposable monkelytics-ci Compose project.');
  }
  return execFileSync('docker', ['compose', ...args], { encoding: 'utf8' }).trim();
}

function setServerTime(iso?: string) {
  compose(
    'exec',
    '-T',
    'umami',
    'node',
    '-e',
    'const fs = require("node:fs"); const file = "/tmp/monkelytics-identity-clock"; if (process.argv[1]) { fs.writeFileSync(file + ".next", process.argv[1]); fs.renameSync(file + ".next", file); } else { fs.rmSync(file, { force: true }); }',
    iso ? String(Date.parse(iso)) : '',
  );
}

test('standard collection preserves explicit identities and historical batch imports', async ({
  request,
}) => {
  test.skip(process.env.COLLECTION_MODE_TEST === 'anonymous', 'Requires standard collection.');
  const config = JSON.parse(compose('config', '--format', 'json'));
  expect(config.services.umami.environment.COLLECTION_MODE).toBe('standard');
  let websiteId: string | undefined;
  let authorization: string;
  try {
    const login = await request.post('/api/auth/login', {
      data: { username: 'admin', password: 'umami' },
    });
    expect(login.status()).toBe(200);
    authorization = `bearer ${(await login.json()).token}`;
    const created = await request.post('/api/websites', {
      headers: { authorization },
      data: { name: 'Standard import integration', domain: 'example.com' },
    });
    expect(created.status()).toBe(200);
    websiteId = (await created.json()).id;
    expect(websiteId).toMatch(/^[0-9a-f-]{36}$/);
    const timestamp = Date.parse('2026-08-15T12:00:00Z') / 1000;
    const payload = { website: websiteId, url: '/historical', timestamp, id: 'customer-42' };
    const batch = await request.post('/api/batch', {
      data: [
        { type: 'identify', payload: { ...payload, data: { plan: 'pro' } } },
        { type: 'event', payload: { ...payload, name: 'historical' } },
      ],
    });
    expect(batch.status()).toBe(200);
    expect(await batch.json()).toMatchObject({ size: 2, processed: 2, errors: 0 });
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
        `select json_agg(t) from (select e.created_at, s.distinct_id, l.distinct_id as linked_id from website_event e join session s on s.session_id = e.session_id and s.website_id = e.website_id join session_link l on l.session_id = s.session_id and l.website_id = s.website_id where e.website_id = '${websiteId}') t`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ distinct_id: 'customer-42', linked_id: 'customer-42' });
    expect(new Date(rows[0].created_at).toISOString()).toBe('2026-08-15T12:00:00.000Z');
  } finally {
    if (websiteId) {
      const deleted = await request.delete(`/api/websites/${websiteId}`, {
        headers: { authorization },
      });
      expect(deleted.status()).toBe(200);
    }
  }
});

test('anonymous collection protects browser, direct and batch writes across UTC midnight', async ({
  page,
  request,
  baseURL,
}) => {
  test.skip(
    process.env.COLLECTION_MODE_TEST !== 'anonymous',
    'Requires the anonymous test overlay.',
  );
  const config = JSON.parse(compose('config', '--format', 'json'));
  expect(config.services.umami.environment.COLLECTION_MODE).toBe('anonymous');
  expect(config.services.umami.environment.SALT_ROTATION).toBe('day');
  expect(config.services.umami.environment.NODE_OPTIONS).toContain('server-clock.cjs');
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
      data: { name: 'Anonymous integration', domain: 'example.com' },
    });
    expect(created.status()).toBe(200);
    websiteId = (await created.json()).id;
    expect(websiteId).toMatch(/^[0-9a-f-]{36}$/);

    // An old, unconfigured tracker can remember an identity after a rejected identify.
    // Accepted events must still rotate and must not persist that carried identity.
    let browserAnonymous = false;
    await page.route(`${baseURL}/anonymous-test`, route =>
      route.fulfill({
        contentType: 'text/html',
        body: `<html><head><script defer src="/script.js" data-website-id="${websiteId}" data-auto-track="false" ${browserAnonymous ? 'data-collection-mode="anonymous" data-before-send="policyCallback"' : ''}></script></head><body>Anonymous test</body></html>`,
      }),
    );
    await page.goto('/anonymous-test');
    await page.waitForFunction(() => !!(window as unknown as { umami: UmamiTracker }).umami);
    const wait = () =>
      page.waitForResponse(
        res => res.url().endsWith('/api/send') && res.request().method() === 'POST',
      );
    let pending = wait();
    await page.evaluate(() =>
      (window as unknown as { umami: UmamiTracker }).umami.identify('customer-42', { plan: 'pro' }),
    );
    expect((await pending).status()).toBe(403);

    async function track(name: string, cache?: string) {
      const pending = wait();
      await page.evaluate(
        name => (window as unknown as { umami: UmamiTracker }).umami.track(name),
        name,
      );
      const response = await pending;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON().payload.id).toBe('customer-42');
      if (cache) expect(await response.request().headerValue('x-umami-cache')).toBe(cache);
      return response.json();
    }

    const first = await track('before-midnight');
    setServerTime('2026-09-16T00:00:00Z');
    const second = await track('after-midnight', first.cache);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.visitId).not.toBe(first.visitId);
    const payload = {
      website: websiteId,
      url: '/direct',
      id: 'customer-42',
      timestamp: Date.parse('2026-09-15T23:59:59Z') / 1000,
    };
    const direct = await request.post('/api/send', {
      data: { type: 'event', payload },
      headers: { 'x-umami-cache': first.cache },
    });
    expect(direct.status()).toBe(200);
    const current = await direct.json();
    expect(current.sessionId).not.toBe(first.sessionId);
    expect(
      JSON.parse(Buffer.from(current.cache.split('.')[1], 'base64url').toString()),
    ).not.toHaveProperty('sessionLinkId');
    const performance = await request.post('/api/send', {
      data: { type: 'performance', payload: { ...payload, lcp: 100 } },
    });
    expect(performance.status()).toBe(200);
    const batch = await request.post('/api/batch', {
      data: [
        { type: 'event', payload: { ...payload, name: 'batch' } },
        { type: 'identify', payload: { ...payload, data: { id: 'customer-42' } } },
      ],
    });
    expect(batch.status()).toBe(200);
    expect(await batch.json()).toMatchObject({
      size: 2,
      processed: 1,
      errors: 1,
      details: [{ index: 1, response: { error: { status: 403 } } }],
    });

    // New tracker filters overrides after callbacks and suppresses identify requests.
    browserAnonymous = true;
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as { umami: UmamiTracker }).umami);
    const sends: string[] = [];
    page.on('request', req => {
      if (req.url().endsWith('/api/send')) sends.push(req.postData() ?? '');
    });
    pending = wait();
    await page.evaluate(async website => {
      const target = window as unknown as {
        umami: UmamiTracker;
        policyCallback: (_type: string, payload: object) => object;
      };
      target.policyCallback = (_type, payload) => ({ ...payload, id: 'customer-42', timestamp: 1 });
      await target.umami.identify('customer-42');
      await target.umami.identify({ id: 'customer-42', plan: 'pro' });
      const overriddenPayload = {
        website,
        url: '/browser',
        id: 'customer-42',
        timestamp: 1,
        name: 'button',
        data: { button: 'sample' },
      };
      await target.umami.track(overriddenPayload);
    }, websiteId);
    const filtered = await pending;
    expect(filtered.status()).toBe(200);
    expect(sends).toHaveLength(1);
    expect(filtered.request().postDataJSON().payload).not.toHaveProperty('id');
    expect(filtered.request().postDataJSON().payload).not.toHaveProperty('timestamp');

    const query = (sql: string) =>
      JSON.parse(
        compose('exec', '-T', 'db', 'psql', '-U', 'umami', '-d', 'umami', '-At', '-c', sql),
      );
    const rows = query(
      `select json_agg(t) from (select e.created_at, e.session_id, s.distinct_id from website_event e join session s on s.session_id = e.session_id and s.website_id = e.website_id where e.website_id = '${websiteId}' order by e.created_at) t`,
    );
    expect(rows).toHaveLength(6);
    expect(
      rows.filter(
        (row: { created_at: string }) =>
          new Date(row.created_at).toISOString() === '2026-09-15T23:59:59.000Z',
      ),
    ).toHaveLength(1);
    expect(
      rows.filter(
        (row: { created_at: string }) =>
          new Date(row.created_at).toISOString() === '2026-09-16T00:00:00.000Z',
      ),
    ).toHaveLength(5);
    expect(rows.every((row: { distinct_id: string | null }) => row.distinct_id === null)).toBe(
      true,
    );
    for (const table of ['session_link', 'session_data']) {
      expect(query(`select count(*) from ${table} where website_id = '${websiteId}'`)).toBe(0);
    }
  } finally {
    try {
      if (websiteId) {
        const deleted = await request.delete(`/api/websites/${websiteId}`, {
          headers: { authorization },
        });
        expect(deleted.status()).toBe(200);
      }
    } finally {
      setServerTime();
    }
  }
});
