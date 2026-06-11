import cors from 'cors';
import { CONFIG } from '../config/index.js';
import { HttpError } from '../utils/guards.js';

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin || CONFIG.ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      // 403, not a generic 500: a disallowed Origin is a client-side policy
      // rejection, not a server fault.
      callback(new HttpError(403, 'Not allowed by CORS'));
    }
  },
});
