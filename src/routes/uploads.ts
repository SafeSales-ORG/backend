import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { env } from '../env.js';
import { BadRequest, HttpError, Unauthorized } from '../lib/errors.js';
import { sniffImage } from '../lib/images.js';
import { verifyToken } from '../services/auth.js';
import { storage } from '../services/storage/index.js';

const UploadSchema = z.object({
  // A data: URL ("data:image/jpeg;base64,…") — the frontend already
  // downscales and compresses before sending.
  dataUrl: z.string().min(30).max(Math.ceil((env.UPLOAD_MAX_BYTES * 4) / 3) + 100),
});

/** A signed-in user, or a buyer proving their order with its secret token. */
async function uploaderId(request: FastifyRequest): Promise<string> {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return `u_${verifyToken(header.slice(7)).sub}`;
  }
  const buyerToken = request.headers['x-buyer-token'];
  if (typeof buyerToken === 'string' && buyerToken.length >= 8) {
    const order = await prisma.order.findUnique({ where: { buyerToken }, select: { id: true, status: true } });
    if (order && order.status !== 'pending_payment') return `o_${order.id}`;
  }
  throw new Unauthorized('Sign in, or open your order link, to upload images');
}

const uploadsRoute: FastifyPluginAsync = async (app) => {
  app.post('/api/uploads', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!storage) {
      throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'Image storage is not configured on this server');
    }
    const owner = await uploaderId(request);
    const { dataUrl } = UploadSchema.parse(request.body);

    const match = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) throw new BadRequest('Send the image as a base64 data:image URL');
    const bytes = Buffer.from(match[1], 'base64');
    if (bytes.length === 0) throw new BadRequest('The image is empty');
    if (bytes.length > env.UPLOAD_MAX_BYTES) {
      throw new HttpError(413, 'IMAGE_TOO_LARGE', `Images must be under ${Math.round(env.UPLOAD_MAX_BYTES / 1024 / 1024)} MB`);
    }

    // Trust the bytes, not the declared type.
    const type = sniffImage(bytes);
    if (!type) throw new HttpError(415, 'UNSUPPORTED_IMAGE', 'Only JPEG, PNG and WebP images are allowed');

    const now = new Date();
    const key = [
      'images',
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      `${crypto.randomUUID()}.${type.ext}`,
    ].join('/');
    const url = await storage.put(key, bytes, type.mime);

    request.log.info?.({ owner, key, bytes: bytes.length }, 'image uploaded');
    reply.code(201);
    return { url, key, contentType: type.mime, bytes: bytes.length };
  });
};

export default uploadsRoute;
