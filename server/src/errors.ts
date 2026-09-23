import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError as ApiErrorBody } from '@props/shared';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Validates untrusted input; a failure becomes a 400 naming the offending fields. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const fields = result.error.issues.map((i) => i.path.join('.') || 'body');
  throw new ApiError(400, 'bad_request', `Invalid ${[...new Set(fields)].join(', ')}`);
}

const body = (code: string, message: string): ApiErrorBody => ({ error: { code, message } });
const CLIENT_ERROR_CODES: Record<number, string> = {
  404: 'not_found', 405: 'method_not_allowed', 413: 'payload_too_large', 415: 'unsupported_media_type',
};

export function errorHandler(err: FastifyError | ApiError, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ApiError) return reply.status(err.statusCode).send(body(err.code, err.message));
  const status = err.statusCode ?? 500;
  if (status === 429) return reply.status(429).send(body('rate_limited', 'Too many requests, slow down'));
  if (status < 500) return reply.status(status).send(body(CLIENT_ERROR_CODES[status] ?? 'bad_request', err.message));
  req.log.error({ err }, 'unhandled error');
  return reply.status(500).send(body('internal', 'Something went wrong'));
}

export function notFoundHandler(req: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send(body('not_found', `No route for ${req.method} ${req.url.split('?')[0]}`));
}
