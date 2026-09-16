import { parseQueryStringPolicy } from '@/tracker/query-string';

export function getQueryStringPolicy() {
  return parseQueryStringPolicy(
    process.env.QUERY_STRING_POLICY,
    process.env.QUERY_STRING_ALLOWLIST,
  );
}
