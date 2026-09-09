const jwt = require('jsonwebtoken');
const config = require('../config/config');

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

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    next();
  } catch {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
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

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    next();
  } catch {
    res.clearCookie('jwt');
    return res.redirect('/login');
  }
};

module.exports = { authenticateJWT, isAuthenticated };
