// Shared by the tracker and server; keep this module browser-safe.
export function parseCollectionMode(value?: string | null) {
  const mode = value ?? 'standard';
  if (mode === 'standard' || mode === 'anonymous') return mode;
  throw new Error('COLLECTION_MODE must be one of: standard, anonymous.');
}
