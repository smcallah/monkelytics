import { parseSaltRotation } from '@/lib/salt-rotation';

export function register() {
  try {
    parseSaltRotation(process.env.SALT_ROTATION);
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
