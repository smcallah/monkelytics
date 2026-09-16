import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { UmamiTracker } from '../../src/tracker';

function compose(...args: string[]) {
  if (process.env.COMPOSE_PROJECT_NAME !== 'monkelytics-ci') {
    throw new Error('This test requires the disposable monkelytics-ci Compose project.');
  }
  return execFileSync('docker', ['compose', ...args], { encoding: 'utf8' }).trim();
}

test('query policy protects browser requests and PostgreSQL while preserving the default', async ({
  page,
  request,
  baseURL,
}) => {
  const mode = process.env.QUERY_STRING_TEST_MODE;
  expect(['preserve', 'allowlist']).toContain(mode);
  const privateMode = mode === 'allowlist';
  const config = JSON.parse(compose('config', '--format', 'json'));
  expect(config.services.umami.environment.QUERY_STRING_POLICY).toBe(mode);
  const query =
    'email=private-email&utm_source=news&utm_campaign=launch&utm_term=private-term&gclid=private-click&fbclid=private-click&msclkid=private-click&ttclid=private-click&li_fat_id=private-click&twclid=private-click';
  const approved = 'utm_source=news&utm_campaign=launch';
  const referrer = `https://other.test/previous?${query}#private-fragment`;
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
      data: { name: 'Query policy integration', domain: 'example.com' },
    });
    expect(created.status()).toBe(200);
    websiteId = (await created.json()).id;
    expect(websiteId).toMatch(/^[0-9a-f-]{36}$/);

    let trackerPrivacy = privateMode;
    await page.route(`${baseURL}/query-test**`, route =>
      route.fulfill({
        contentType: 'text/html',
        body: `<html><head><title>Query test</title><script defer src="/script.js" data-website-id="${websiteId}" ${trackerPrivacy ? 'referrerpolicy="no-referrer" data-query-string-policy="allowlist" data-query-string-allowlist="utm_source,utm_campaign"' : ''}></script></head><body>Query test</body></html>`,
      }),
    );
    const waitForSend = () =>
      page.waitForResponse(
        response => response.url().endsWith('/api/send') && response.request().method() === 'POST',
      );
    async function verifyRequest(
      response: Awaited<ReturnType<typeof waitForSend>>,
      filtered: boolean,
    ) {
      expect(response.status()).toBe(200);
      const payload = response.request().postDataJSON().payload;
      expect(new URL(payload.url).search.slice(1)).toBe(filtered ? approved : query);
      if (filtered) {
        expect(JSON.stringify(payload)).not.toContain('private-');
        expect(await response.request().headerValue('referer')).toBeNull();
      }
    }

    // Real built tracker: automatic pageview, SPA, object payload and callback.
    const scriptRequest = page.waitForRequest(request => request.url().endsWith('/script.js'));
    let sent = waitForSend();
    await page.goto(`/query-test?${query}#private-fragment`, { referer: referrer });
    const script = await scriptRequest;
    if (privateMode) expect(await script.headerValue('referer')).toBeNull();
    await verifyRequest(await sent, privateMode);
    sent = waitForSend();
    await page.evaluate(
      url => history.pushState({}, '', url),
      `/query-test/next?${query}#private-fragment`,
    );
    await verifyRequest(await sent, privateMode);
    sent = waitForSend();
    await page.evaluate(
      ({ website, url, referrer }) =>
        (window as unknown as { umami: UmamiTracker }).umami.track({
          website,
          url,
          referrer,
        }),
      { website: websiteId, url: `https://example.com/manual?${query}#private-fragment`, referrer },
    );
    await verifyRequest(await sent, privateMode);
    sent = waitForSend();
    await page.evaluate(
      ({ url, referrer }) =>
        (window as unknown as { umami: UmamiTracker }).umami.track(payload => ({
          ...payload,
          url,
          referrer,
          name: 'callback',
        })),
      { url: `https://example.com/callback?${query}#private-fragment`, referrer },
    );
    await verifyRequest(await sent, privateMode);

    // Old/unconfigured trackers still send raw URLs: the server must filter them.
    trackerPrivacy = false;
    sent = waitForSend();
    await page.goto(`/query-test/legacy?${query}#private-fragment`, { referer: referrer });
    await verifyRequest(await sent, false);
    const batch = await request.post('/api/batch', {
      headers: {
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      },
      data: [
        {
          type: 'event',
          payload: {
            website: websiteId,
            url: `/batch?${query}#private-fragment`,
            referrer,
            name: 'batch',
          },
        },
      ],
    });
    expect(batch.status()).toBe(200);
    expect(await batch.json()).toMatchObject({ processed: 1, errors: 0 });

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
        `select json_agg(t) from (select * from website_event where website_id = '${websiteId}') t`,
      ),
    );
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.url_query).toBe(privateMode ? approved : query);
      expect(row.referrer_query).toBe(privateMode ? '' : query);
      expect(row.utm_source).toBe('news');
      expect(row.utm_campaign).toBe('launch');
      expect(row.utm_term).toBe(privateMode ? null : 'private-term');
      for (const column of ['gclid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id', 'twclid']) {
        expect(row[column]).toBe(privateMode ? null : 'private-click');
      }
    }
    if (privateMode) expect(JSON.stringify(rows)).not.toContain('private-');
  } finally {
    if (websiteId) {
      const deleted = await request.delete(`/api/websites/${websiteId}`, {
        headers: { authorization },
      });
      expect(deleted.status()).toBe(200);
    }
  }
});
