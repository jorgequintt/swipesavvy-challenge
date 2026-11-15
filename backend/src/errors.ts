export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new ApiError(400, 'VALIDATION', message, details);

export const notFound = (rsrc: string) => new ApiError(404, 'NOT_FOUND', `${rsrc} not found`);

