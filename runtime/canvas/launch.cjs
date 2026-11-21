// The upstream packaged server requires a local collaboration authority even
// though Greenroom exposes only the authenticated member canvas.
process.env.T8_COLLAB_MANAGEMENT_TOKEN = require('node:crypto').randomBytes(32).toString('base64url');
require('/app/backend/src/server.js');
