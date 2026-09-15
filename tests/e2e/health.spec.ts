import { expect, test } from '@playwright/test';

test('health responds publicly with uncached JSON and no session cookie', async ({ request }) => {
  const response = await request.get('health', { maxRedirects: 0 });

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()['set-cookie']).toBeUndefined();
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('health supports HEAD without a response body', async ({ request }) => {
  const response = await request.head('health', { maxRedirects: 0 });

  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.body()).toHaveLength(0);
});

test('health rejects POST requests', async ({ request }) => {
  const response = await request.post('health', { maxRedirects: 0 });

  expect(response.status()).toBe(405);
});

test('the existing heartbeat response remains compatible', async ({ request }) => {
  const response = await request.get('api/heartbeat', { maxRedirects: 0 });

  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
