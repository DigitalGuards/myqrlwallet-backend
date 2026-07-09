import cors from 'cors';
import { CONFIG } from '../config/index.js';
import { HttpError } from '../utils/guards.js';

// Browser-extension origins are allowed as a SCHEME rather than per-ID:
// unpacked extension IDs differ per machine, and a request WITHOUT an
// Origin header (curl, native clients) already passes below, so an
// extension page gains no capability a headerless client does not have.
// Web pages remain gated by the ALLOWED_ORIGINS allowlist.
const EXTENSION_SCHEMES = ['chrome-extension://', 'moz-extension://', 'safari-web-extension://'];

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (
      !origin ||
      CONFIG.ALLOWED_ORIGINS.includes(origin) ||
      // Schemes are case-insensitive (RFC 6454); browsers normalize the
      // Origin header to lowercase, but custom clients may not.
      EXTENSION_SCHEMES.some((scheme) => origin.toLowerCase().startsWith(scheme))
    ) {
      callback(null, true);
    } else {
      // 403, not a generic 500: a disallowed Origin is a client-side policy
      // rejection, not a server fault.
      callback(new HttpError(403, 'Not allowed by CORS'));
    }
  },
});
