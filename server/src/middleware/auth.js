/**
 * JWT authentication.
 *
 * The token travels in `Authorization: Bearer` for API calls and in an httpOnly
 * cookie for browser-native requests (`<video>`, `<img>`, downloads) where
 * headers cannot be set. `?access_token=` is also accepted for the same reason
 * (and for SSE, whose EventSource API cannot send headers).
 */
import jwt from 'jsonwebtoken';
import config from '../config.js';
import { db } from '../db/index.js';
import { ApiError, asyncHandler } from '../lib/errors.js';

export function signToken(user) {
  return jwt.sign({ sub: user._id, email: user.email, name: user.name }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw ApiError.unauthorized('Your session expired — please sign in again');
    throw ApiError.unauthorized('Invalid session token');
  }
}

export function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  if (req.cookies?.[config.jwt.cookieName]) return req.cookies[config.jwt.cookieName];
  if (req.query?.access_token) return String(req.query.access_token);
  return null;
}

export function setAuthCookie(res, token) {
  res.cookie(config.jwt.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/',
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(config.jwt.cookieName, { path: '/' });
}

async function loadUser(req) {
  const token = extractToken(req);
  if (!token) return null;
  const payload = verifyToken(token);
  const user = await db.users.findOne({ _id: payload.sub });
  if (!user) throw ApiError.unauthorized('This account no longer exists');
  return user;
}

export const requireAuth = asyncHandler(async (req, _res, next) => {
  req.user = await loadUser(req);
  if (!req.user) throw ApiError.unauthorized();
  req.userId = req.user._id;
  next();
});

export const optionalAuth = asyncHandler(async (req, _res, next) => {
  try {
    req.user = await loadUser(req);
    if (req.user) req.userId = req.user._id;
  } catch {
    req.user = null;
  }
  next();
});

/** Strips credentials before a user document leaves the server. */
export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return { ...rest, id: user._id };
}

export default { requireAuth, optionalAuth, signToken, verifyToken, publicUser };
