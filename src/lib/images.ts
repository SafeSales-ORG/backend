import { z } from 'zod';
import { env } from '../env.js';

export type ImageType = { mime: 'image/jpeg' | 'image/png' | 'image/webp'; ext: 'jpg' | 'png' | 'webp' };

/** Identify an image from its first bytes. SVG and anything else is rejected. */
export function sniffImage(buf: Buffer): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

const localDev = env.NODE_ENV !== 'production';

/**
 * Image URLs we accept on listings, shop photos and dispute evidence:
 * https, inline data:image (legacy / storage not configured), and plain
 * http to localhost in development (local storage provider).
 */
export function imageUrl(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .refine(
      (v) =>
        v.startsWith('https://') ||
        v.startsWith('data:image/') ||
        (localDev && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(v)),
      'Image must be an https or data:image URL',
    );
}
