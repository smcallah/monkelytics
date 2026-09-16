import { parseSaltRotation } from '@/lib/salt-rotation';

export function register() {
  parseSaltRotation(process.env.SALT_ROTATION);
}
