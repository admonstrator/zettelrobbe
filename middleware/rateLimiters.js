// @ts-check
'use strict';

/**
 * Rate limiters that more than one route uses.
 *
 * express-rate-limit keeps its counts inside the limiter instance, so each one
 * must exist exactly once: a router that built its own copy would get a second
 * counter and with it twice the budget.
 */

const { rateLimit } = require('express-rate-limit');
const config = require('../config/config.js');
const { renderLoginView } = require('../services/loginView');

/**
 * Rate limiter for cache clearing operations
 * Prevents abuse of cache invalidation endpoints by limiting requests to 10 per 15 minutes per IP
 *
 * @see https://github.com/admonstrator/zettelrobbe/security/code-scanning/143
 */
const cacheClearLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: {
    success: false,
    error: 'Too many cache clear requests. Please try again later.',
    retryAfter: '15 minutes',
  },
  standardHeaders: true, // Return rate limit info in RateLimit-* headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  // Skip rate limiting for API key authenticated requests (trusted clients)
  skip: (req) => {
    const apiKey = req.headers['x-api-key'];
    const currentApiKey = config.getApiKey();
    return Boolean(currentApiKey && apiKey && apiKey === currentApiKey);
  },
});

/** Budget for the password form; LOGIN_RATE_LIMIT_MAX is read at boot. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    return renderLoginView(res, {
      error:
        'Too many login attempts. Please wait a few minutes and try again.',
    });
  },
});

module.exports = { cacheClearLimiter, loginLimiter };
