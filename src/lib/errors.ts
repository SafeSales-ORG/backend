import { Prisma } from '@prisma/client';

export type ErrorPayload = {
  code: string;
  message: string;
  details?: unknown;
};

export class HttpError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toPayload(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined && { details: this.details }),
    };
  }
}

export class BadRequest extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

export class Unauthorized extends HttpError {
  constructor(message = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class NotFound extends HttpError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class Forbidden extends HttpError {
  constructor(message: string, details?: unknown) {
    super(403, 'FORBIDDEN', message, details);
  }
}

export class Conflict extends HttpError {
  constructor(message: string, details?: unknown) {
    super(409, 'CONFLICT', message, details);
  }
}

export class UnprocessableEntity extends HttpError {
  constructor(message: string, details?: unknown) {
    super(422, 'UNPROCESSABLE_ENTITY', message, details);
  }
}

export class ServiceUnavailable extends HttpError {
  constructor(message: string, details?: unknown) {
    super(503, 'SERVICE_UNAVAILABLE', message, details);
  }
}

/** True when a Prisma error is a unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
