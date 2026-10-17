import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { StorageProvider } from './types.js';

/**
 * Any S3-compatible bucket: AWS S3, Cloudflare R2, DigitalOcean Spaces,
 * Supabase Storage, Backblaze B2. The bucket (or a CDN in front of it) must
 * serve objects publicly at `publicUrl`.
 */
export function s3StorageProvider(opts: {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl: string;
}): StorageProvider {
  const client = new S3Client({
    region: opts.region,
    endpoint: opts.endpoint,
    forcePathStyle: !!opts.endpoint,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  });
  return {
    name: 's3',
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
      return `${opts.publicUrl}/${key}`;
    },
  };
}
