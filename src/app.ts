import express from 'express';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import { rpcJsonBody, rpcRateLimitLargeBody } from './middleware/rpc-body.js';
import { rpcRateLimitGeneral } from './middleware/rpc-security.js';
import { routes } from './routes/index.js';
import { isTrustedProxy } from './utils/client-ip.js';

const app = express();

// Middleware
// Admit RPC traffic before parsing JSON so malformed and oversized bodies
// consume the same per-IP quota as valid and application-rejected requests.
app.use('/api/qrl-rpc/:network', rpcRateLimitGeneral);
// POST on the exact RPC route parses its own body (50 KB, with a larger limit
// for qrl_sendRawTransaction, qrl_call and qrl_estimateGas) behind a strict
// limiter for large bodies; the parser below then skips it. Every other verb
// and path keeps the global limit.
app.post('/api/qrl-rpc/:network', rpcRateLimitLargeBody, rpcJsonBody);
// API clients send plain JSON. Reject encodings before creating a decoder.
app.use(express.json({ limit: '50kb', inflate: false }));
app.use(corsMiddleware);
app.set('trust proxy', isTrustedProxy);

// Routes
app.use(routes);

// Error handling
app.use(errorHandler);

export { app };
