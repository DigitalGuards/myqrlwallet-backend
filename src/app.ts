import express from 'express';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import { rpcRateLimitGeneral } from './middleware/rpc-security.js';
import { routes } from './routes/index.js';
import { isTrustedProxy } from './utils/client-ip.js';

const app = express();

// Middleware
// Admit RPC traffic before parsing JSON so malformed and oversized bodies
// consume the same per-IP quota as valid and application-rejected requests.
app.use('/api/qrl-rpc/:network', rpcRateLimitGeneral);
// API clients send plain JSON. Reject encodings before creating a decoder.
app.use(express.json({ limit: '50kb', inflate: false }));
app.use(corsMiddleware);
app.set('trust proxy', isTrustedProxy);

// Routes
app.use(routes);

// Error handling
app.use(errorHandler);

export { app };
