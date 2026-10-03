import { parseCollectionMode } from '@/tracker/collection-mode';

export function getCollectionMode() {
  return parseCollectionMode(process.env.COLLECTION_MODE);
}
