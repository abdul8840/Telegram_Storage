/** HTTP-aware error type + express glue so controllers can throw freely. */

export class ApiError extends Error {
  constructor(status, message, details = undefined, code = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code;
  }

  static badRequest(msg = 'Bad request', details) {
    return new ApiError(400, msg, details);
  }
  static unauthorized(msg = 'Authentication required') {
    return new ApiError(401, msg);
  }
  static forbidden(msg = 'Not allowed') {
    return new ApiError(403, msg);
  }
  static notFound(msg = 'Not found') {
    return new ApiError(404, msg);
  }
  static conflict(msg = 'Conflict', details, code) {
    return new ApiError(409, msg, details, code);
  }
  static payload(msg = 'Payload too large') {
    return new ApiError(413, msg);
  }
  static internal(msg = 'Internal server error', details) {
    return new ApiError(500, msg, details);
  }
  static upstream(msg = 'Upstream service error', details) {
    return new ApiError(502, msg, details);
  }
}

/** Wraps an async route handler so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
export function errorMiddleware(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const payload = {
    error: err.expose === false && status === 500 ? 'Internal server error' : err.message || 'Internal server error',
  };
  if (err.details) payload.details = err.details;
  if (err.code) payload.code = err.code;
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(`\x1b[31m${new Date().toISOString()} ERROR [http]\x1b[0m`, err);
  }
  if (res.headersSent) return;
  res.status(status).json(payload);
}

/** Maps well-known Telegram/MTProto RPC errors to friendly messages. */
export function describeTelegramError(err) {
  const raw = err?.errorMessage || err?.message || String(err);
  const map = [
    [/AUTH_KEY_DUPLICATED/i, () => 'This Telegram login was invalidated because its session key was opened by another server. Reconnect Telegram on this deployment.'],
    [/FLOOD_WAIT_(\d+)/i, (m) => `Telegram rate limit reached. Retry in ${m[1]} seconds.`],
    [/FILE_REFERENCE_EXPIRED/i, () => 'The Telegram file reference expired (it was refreshed automatically, please retry).'],
    [/AUTH_KEY_UNREGISTERED|USER_DEACTIVATED/i, () => 'The Telegram session is no longer valid. Please reconnect your account.'],
    [/SESSION_REVOKED|SESSION_EXPIRED/i, () => 'This Telegram session was revoked. Please reconnect your account.'],
    [/CHANNEL_PRIVATE|CHAT_WRITE_FORBIDDEN|PEER_ID_INVALID/i, () => 'Telegram refused access to the destination chat. Check the chat target setting.'],
    [/FILE_TOO_BIG/i, () => 'File exceeds the Telegram upload limit (2 GB, 4 GB with Premium).'],
    [/MEDIA_INVALID|VIDEO_CONTENT_TYPE_ERROR/i, () => 'Telegram rejected this media type; it was retried as a plain document.'],
    [/RPC_ERROR|TIMEOUT|NETWORK/i, () => `Telegram network error: ${raw}`],
  ];
  for (const [re, fn] of map) {
    const m = raw.match(re);
    if (m) return fn(m);
  }
  return raw;
}
