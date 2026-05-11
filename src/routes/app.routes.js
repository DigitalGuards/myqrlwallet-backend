import express from 'express';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import { logger } from '../utils/logger.js';

const log = logger.child({ module: 'app-routes' });

const appRouter = express.Router();

const txHistoryRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per IP
  message: { message: 'Too many requests, please try again later.' },
});

const TX_HISTORY_MAX_LIMIT = 50;
const TX_HISTORY_TIMEOUT_MS = 8000;

const clampPositiveInt = (raw, fallback, max) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  const i = Math.floor(n);
  return max ? Math.min(i, max) : i;
};

appRouter.post('/tx-history', txHistoryRateLimit, async (req, res) => {
  const { address } = req.body;

  // Validate address format (Q + 40 hex chars)
  if (!address || typeof address !== 'string' || !/^Q[a-fA-F0-9]{40}$/i.test(address)) {
    return res.status(400).json({ message: 'Invalid address format' });
  }

  // Clamp page/limit before proxying. Without this, a single request with
  // limit=100000 forces zondscan to return (and us to buffer) an enormous
  // response, and a no-timeout axios call below would block the worker for
  // the full TCP timeout (~2 min) if zondscan stalls.
  const page = clampPositiveInt(req.body.page, 1, null);
  const limit = clampPositiveInt(req.body.limit, 5, TX_HISTORY_MAX_LIMIT);

  const formattedAddress = 'Q' + address.slice(1).toLowerCase();
  try {
    const response = await axios.get(
      `https://zondscan.com/api/address/${formattedAddress}/transactions`,
      { params: { page, limit }, timeout: TX_HISTORY_TIMEOUT_MS }
    );
    log.debug({ address: formattedAddress }, 'Tx history fetched');
    res.status(200).json(response.data);
  } catch (error) {
    const code = error?.code;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      log.warn({ address: formattedAddress, code }, 'Tx history upstream timeout');
      return res.status(504).json({ message: 'Upstream timeout fetching tx history' });
    }
    log.error({ error, address: formattedAddress }, 'Failed to get tx history');
    res.status(500).json({ message: 'Failed to get tx history' });
  }
});

export default appRouter;
