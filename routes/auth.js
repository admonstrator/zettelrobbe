const jwt = require('jsonwebtoken');
const config = require('../config/config');

/**
 * Claim that marks a JWT as a full session token.
 *
 * The MFA login challenge and the MFA setup challenge are signed with the same
 * secret as a session, so a bare `jwt.verify()` cannot tell them apart from a
 * completed sign-in. Every guard therefore demands this explicit type claim,
 * and the challenge verifiers keep demanding their own claims in return.
 */
const SESSION_TOKEN_TYPE = 'session';

/**
 * Verifies a JWT and returns its payload only if it is a session token.
 *
 * Returns null for an invalid signature, an expired token, and for any token
 * minted for a different purpose (MFA login challenge, MFA setup), so callers
 * can treat all of those the same way.
 *
 * @param {string} token - the raw JWT
 * @param {string} jwtSecret - the signing secret
 * @returns {object|null} the decoded payload, or null
 */
function verifySessionToken(token, jwtSecret) {
  try {
    const decoded = jwt.verify(token, jwtSecret);
    if (!decoded || decoded.typ !== SESSION_TOKEN_TYPE) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

// JWT middleware to verify token
const authenticateJWT = (req, res, next) => {
  const token = req.cookies.jwt || req.headers.authorization?.split(' ')[1];
  const apiKey = req.headers['x-api-key'];
  const currentApiKey = config.getApiKey();
  const jwtSecret = config.getJwtSecret();

  if (currentApiKey && apiKey && apiKey === currentApiKey) {
    req.user = { apiKey: true };
    return next();
  }

  if (!jwtSecret) {
    return res
      .status(500)
      .json({ message: 'Server misconfiguration: JWT secret missing' });
  }

  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  const decoded = verifySessionToken(token, jwtSecret);
  if (!decoded) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }

  req.user = decoded;
  next();
};

const isAuthenticated = (req, res, next) => {
  const token = req.cookies.jwt || req.headers.authorization?.split(' ')[1];
  const apiKey = req.headers['x-api-key'];
  const currentApiKey = config.getApiKey();
  const jwtSecret = config.getJwtSecret();

  if (currentApiKey && apiKey && apiKey === currentApiKey) {
    req.user = { apiKey: true };
    return next();
  }

  if (!jwtSecret) {
    return res.status(500).send('Server misconfiguration: JWT secret missing');
  }

  if (!token) {
    return res.redirect('/login');
  }

  const decoded = verifySessionToken(token, jwtSecret);
  if (!decoded) {
    res.clearCookie('jwt');
    return res.redirect('/login');
  }

  req.user = decoded;
  next();
};

module.exports = {
  authenticateJWT,
  isAuthenticated,
  verifySessionToken,
  SESSION_TOKEN_TYPE,
};
