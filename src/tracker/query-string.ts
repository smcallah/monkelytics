// Shared by the browser tracker and collection server. Keep this module browser-safe.
const campaignParameters = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

export function parseQueryStringPolicy(mode?: string | null, allowlist?: string | null) {
  const policy = mode ?? 'preserve';
  if (policy !== 'preserve' && policy !== 'allowlist') {
    throw new Error('QUERY_STRING_POLICY must be one of: preserve, allowlist.');
  }
  const allowed = allowlist ? allowlist.split(',').map(name => name.trim()) : [];
  if (allowed.some(name => !campaignParameters.includes(name))) {
    throw new Error('QUERY_STRING_ALLOWLIST must contain only supported lowercase UTM names.');
  }
  if (policy === 'preserve' && allowed.length) {
    throw new Error('QUERY_STRING_ALLOWLIST requires QUERY_STRING_POLICY=allowlist.');
  }
  return { mode: policy, allowed };
}

export type QueryStringPolicy = ReturnType<typeof parseQueryStringPolicy>;

// Filter before extracting query strings or dedicated attribution columns.
export function filterQueryString(url: URL, policy: QueryStringPolicy, referrer = false): URL {
  if (policy.mode === 'preserve') return url;
  const filtered = new URL(url.href);
  filtered.search = '';
  filtered.hash = '';
  filtered.username = '';
  filtered.password = '';
  if (!referrer) {
    for (const [name, value] of url.searchParams) {
      if (policy.allowed.includes(name)) filtered.searchParams.append(name, value);
    }
  }
  return filtered;
}
