import { getCollectionMode } from '@/lib/collection-mode';
import { getQueryStringPolicy } from '@/lib/query-string';
import { parseSaltRotation } from '@/lib/salt-rotation';
import { loadTrackingPlans } from '@/lib/tracking-plan';

export function register() {
  try {
    parseSaltRotation(process.env.SALT_ROTATION);
    getQueryStringPolicy();
    getCollectionMode();
    loadTrackingPlans();
  } catch (error) {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
      // Next.js can keep its listener alive after a rejected instrumentation hook.
      // Invalid startup configuration must stop the server, not leave it unusable.
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
    throw error;
  }
}
