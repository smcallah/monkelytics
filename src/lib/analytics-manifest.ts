import { isNode, isScalar, LineCounter, parseDocument, visit } from 'yaml';
import { z } from 'zod';

export const MANIFEST_MAX_BYTES = 256 * 1024;
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
const propertyName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,49}$/)
  .refine(value => !reserved.has(value), 'Reserved property name');
const eventName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,49}$/)
  .refine(value => !reserved.has(value), 'Reserved event name');
const propertySchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().default(false),
});
const eventSchema = z.strictObject({
  properties: z
    .record(propertyName, propertySchema)
    .default({})
    .refine(value => Object.keys(value).length <= 50, 'At most 50 properties per event'),
});
const siteSchema = z.strictObject({
  mode: z.enum(['observe', 'reject']).default('observe'),
  events: z
    .record(eventName, eventSchema)
    .refine(
      value => Object.keys(value).length > 0 && Object.keys(value).length <= 200,
      'Declare between 1 and 200 events per website',
    ),
});
const schema = z
  .strictObject({
    version: z.literal(1),
    websites: z
      .record(z.string(), siteSchema)
      .refine(value => Object.keys(value).length <= 100, 'At most 100 websites per manifest'),
  })
  .superRefine((manifest, context) => {
    for (const id of Object.keys(manifest.websites)) {
      if (!z.uuid().safeParse(id).success || id !== id.toLowerCase()) {
        context.addIssue({
          code: 'custom',
          path: ['websites', id],
          message: 'Website key must be a lowercase UUID',
        });
      }
    }
  });

export type AnalyticsManifest = z.infer<typeof schema>;
export type TrackingPlan = AnalyticsManifest['websites'][string];
export type EventIssue = {
  code:
    | 'undeclared_event'
    | 'undeclared_property'
    | 'missing_property'
    | 'invalid_type'
    | 'too_long';
  property?: string;
};

export function parseAnalyticsManifest(
  source: string,
  filename = 'analytics.yaml',
): AnalyticsManifest {
  if (new TextEncoder().encode(source).byteLength > MANIFEST_MAX_BYTES) {
    throw new Error(`${filename}:1:1: Manifest exceeds ${MANIFEST_MAX_BYTES} bytes`);
  }
  const lines = new LineCounter();
  const document = parseDocument(source, {
    lineCounter: lines,
    prettyErrors: false,
    uniqueKeys: true,
  });
  const at = (offset: number, message: string) => {
    const { line, col } = lines.linePos(offset);
    return `${filename}:${line}:${col}: ${message}`;
  };
  const syntax = [...document.errors, ...document.warnings];
  if (syntax.length)
    throw new Error(syntax.map(error => at(error.pos[0], error.message)).join('\n'));
  visit(document, {
    Pair(_key, pair) {
      if (
        isScalar(pair.key) &&
        typeof pair.key.value === 'string' &&
        reserved.has(pair.key.value)
      ) {
        throw new Error(at(pair.key.range?.[0] ?? 0, 'Reserved property or event name'));
      }
    },
  });
  let input: unknown;
  try {
    // Aliases are unnecessary for this format and can amplify small files.
    input = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error(at(0, 'YAML aliases are not supported'));
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.flatMap(issue =>
      issue.code === 'invalid_key'
        ? issue.issues.map(child => ({ ...child, path: [...issue.path, ...child.path] }))
        : [issue],
    );
    throw new Error(
      issues
        .map(issue => {
          let path = [...issue.path];
          let offset = 0;
          while (path.length) {
            try {
              const node = document.getIn(path, true);
              if (isNode(node) && node.range) {
                offset = node.range[0];
                break;
              }
            } catch {
              /* Missing/invalid fields use the nearest parent location. */
            }
            path = path.slice(0, -1);
          }
          return at(offset, `${issue.path.map(String).join('.') || 'manifest'}: ${issue.message}`);
        })
        .join('\n'),
    );
  }
  return parsed.data;
}

// Validate only the declared custom event contract. Never include property values
// in diagnostics, and never mutate the original payload in observation mode.
export function validatePlannedEvent(
  plan: TrackingPlan,
  name: string,
  data: Record<string, unknown> = {},
): EventIssue[] {
  if (!Object.hasOwn(plan.events, name)) return [{ code: 'undeclared_event' }];
  const properties = plan.events[name].properties;
  const issues: EventIssue[] = [];
  for (const key of Object.keys(data)) {
    if (!Object.hasOwn(properties, key))
      issues.push({ code: 'undeclared_property', property: key });
  }
  for (const [key, property] of Object.entries(properties)) {
    if (!Object.hasOwn(data, key)) {
      if (property.required) issues.push({ code: 'missing_property', property: key });
      continue;
    }
    const value = data[key];
    if (typeof value !== property.type || (typeof value === 'number' && !Number.isFinite(value))) {
      issues.push({ code: 'invalid_type', property: key });
    } else if (typeof value === 'string' && value.length > 500) {
      issues.push({ code: 'too_long', property: key });
    }
  }
  return issues;
}
