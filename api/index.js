// Vercel function entry. Loads the Express app from ../server.js
// and uses it as the request handler. The Express app handles all
// route dispatch internally (`/api/leads`, `/api/stats`, etc.).
//
// vercel.json rewrites every /api/* path to this file so Express
// sees the original URL and routes correctly.
module.exports = require('../server');
