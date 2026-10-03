import type { AnalyticsManifest } from './analytics-manifest';

export function generateAnalyticsHelper(manifest: AnalyticsManifest, websiteId: string) {
  const id = websiteId.toLowerCase();
  const plan = Object.hasOwn(manifest.websites, id) ? manifest.websites[id] : undefined;
  if (!plan) throw new Error('Website ID is not declared in this manifest');
  const order = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);
  const events = Object.entries(plan.events).sort(order);
  const definitions = events.map(([name, event]) => {
    const fields = Object.entries(event.properties)
      .sort(order)
      .map(
        ([key, value]) => `    ${JSON.stringify(key)}${value.required ? '' : '?'}: ${value.type};`,
      );
    return `  ${JSON.stringify(name)}: ${fields.length ? `{\n${fields.join('\n')}\n  }` : 'Record<string, never>'};`;
  });
  return `// Generated from analytics.yaml. Regenerate after changing the tracking plan.
// Bind this helper to the existing Umami tracker after its script has loaded.
export type AnalyticsEvents = {
${definitions.join('\n')}
};

export type AnalyticsArguments = {
  [E in keyof AnalyticsEvents]: {} extends AnalyticsEvents[E]
    ? [name: E, data?: AnalyticsEvents[E]]
    : [name: E, data: AnalyticsEvents[E]]
}[keyof AnalyticsEvents];

type Tracker = {
  track(callback: (payload: { website: string }) => { website: string; name: string; data?: object }): Promise<void>;
};

export function createAnalytics(tracker: Tracker) {
  return function track(...args: AnalyticsArguments): Promise<void> {
    const [name, data] = args;
    return tracker.track(payload => ({ ...payload, website: ${JSON.stringify(id)}, name, ...(data !== undefined && { data }) }));
  };
}
`;
}
