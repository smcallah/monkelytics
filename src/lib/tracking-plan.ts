import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type AnalyticsManifest,
  type EventIssue,
  MANIFEST_MAX_BYTES,
  parseAnalyticsManifest,
} from './analytics-manifest';

type Snapshot = { path: string; manifest?: AnalyticsManifest; reported: Set<string> };
const state = globalThis as typeof globalThis & { __monkelyticsTrackingPlan?: Snapshot };

export function loadTrackingPlans() {
  const configured = process.env.ANALYTICS_MANIFEST_PATH;
  const path = configured ? resolve(configured) : '';
  if (state.__monkelyticsTrackingPlan?.path === path)
    return state.__monkelyticsTrackingPlan.manifest;
  let manifest: AnalyticsManifest | undefined;
  if (path) {
    let source: string;
    try {
      const file = statSync(path);
      if (!file.isFile() || file.size > MANIFEST_MAX_BYTES)
        throw new Error('Expected a manifest file of at most 256 KiB');
      source = readFileSync(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(`ANALYTICS_MANIFEST_PATH: ${code || (error as Error).message}`);
    }
    manifest = parseAnalyticsManifest(source, path);
  }
  // A process uses one validated snapshot until restarted. Share it between
  // Next.js instrumentation and route bundles so file edits cannot bypass policy.
  state.__monkelyticsTrackingPlan = { path, manifest, reported: new Set() };
  return manifest;
}

export function getTrackingPlan(websiteId: string) {
  const websites = loadTrackingPlans()?.websites;
  const id = websiteId.toLowerCase();
  return websites && Object.hasOwn(websites, id) ? websites[id] : undefined;
}

export function reportTrackingIssues(websiteId: string, issues: EventIssue[]) {
  loadTrackingPlans();
  const reported = state.__monkelyticsTrackingPlan.reported;
  const codes = [...new Set(issues.map(issue => issue.code))].filter(code => {
    const key = `${websiteId.toLowerCase()}:${code}`;
    if (reported.has(key)) return false;
    reported.add(key);
    return true;
  });
  // At most five codes per configured website per process; never log values,
  // names, URLs, user agents, visitor IDs or IP addresses.
  if (codes.length)
    console.warn('Tracking plan mismatch', { websiteId: websiteId.toLowerCase(), codes });
}
