/** An error whose message is safe to show to the user. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Domain rule violation (e.g. insufficient stock). Message is user-safe. */
export class UserFacingError extends HttpError {
  constructor(message: string, code = 'invalid', status = 422) {
    super(status, message, code);
    this.name = 'UserFacingError';
  }
}
