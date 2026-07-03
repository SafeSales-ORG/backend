import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, JwtPayload } from '../services/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload;
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' },
    });
  }

  const token = header.slice(7);
  try {
    request.user = verifyToken(token);
  } catch {
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
    });
  }
}

export async function optionalAuth(request: FastifyRequest, _reply: FastifyReply) {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return;
  }

  const token = header.slice(7);
  try {
    request.user = verifyToken(token);
  } catch {
    // Silently ignore — user stays null
  }
}
