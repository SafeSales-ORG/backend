import { env } from '../../env.js';
import { localStorageProvider } from './local.js';
import { s3StorageProvider } from './s3.js';
import type { StorageProvider } from './types.js';

export type { StorageProvider } from './types.js';

function build(): StorageProvider | null {
  if (env.STORAGE_PROVIDER === 'local') {
    return localStorageProvider(env.STORAGE_LOCAL_DIR, env.STORAGE_PUBLIC_URL ?? `${env.PUBLIC_API_URL}/uploads`);
  }
  if (env.STORAGE_PROVIDER === 's3') {
    return s3StorageProvider({
      bucket: env.S3_BUCKET!,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      publicUrl: env.STORAGE_PUBLIC_URL!,
    });
  }
  return null;
}

/** Null when uploads aren't configured (STORAGE_PROVIDER=none). */
export const storage: StorageProvider | null = build();
