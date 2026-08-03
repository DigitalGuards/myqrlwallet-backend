import express from 'express';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import { asyncHandler } from '../utils/async-handler.js';
import { isRecord } from '../utils/guards.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ module: 'app-routes' });

const appRouter = express.Router();

const txHistoryRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per IP
  message: { message: 'Too many requests, please try again later.' },
});

const TX_HISTORY_MAX_LIMIT = 50;
const TX_HISTORY_MAX_PAGE = 100_000;
const TX_HISTORY_TIMEOUT_MS = 8000;
const TX_HISTORY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const clampPositiveInt = (raw: unknown, fallback: number, max: number | null): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  const i = Math.floor(n);
  return max ? Math.min(i, max) : i;
};

appRouter.post(
  '/tx-history',
  txHistoryRateLimit,
  asyncHandler(async (req, res) => {
    const body: unknown = req.body;
    const address = isRecord(body) ? body.address : undefined;

    // Validate address format (Q + 40 hex chars)
    if (typeof address !== 'string' || !/^Q[a-fA-F0-9]{40}$/i.test(address)) {
      res.status(400).json({ message: 'Invalid address format' });
      return;
    }

    // Clamp page/limit before proxying. Without this, a single request with
    // limit=100000 forces zondscan to return (and us to buffer) an enormous
    // response, and a no-timeout axios call below would block the worker for
    // the full TCP timeout (~2 min) if zondscan stalls.
    const page = clampPositiveInt(isRecord(body) ? body.page : undefined, 1, TX_HISTORY_MAX_PAGE);
    const limit = clampPositiveInt(
      isRecord(body) ? body.limit : undefined,
      5,
      TX_HISTORY_MAX_LIMIT
    );

    const formattedAddress = 'Q' + address.slice(1).toLowerCase();
    try {
      const response = await axios.get<unknown>(
        `https://zondscan.com/api/address/${formattedAddress}/transactions`,
        {
          params: { page, limit },
          timeout: TX_HISTORY_TIMEOUT_MS,
          maxContentLength: TX_HISTORY_MAX_RESPONSE_BYTES,
          // Keep this fixed-origin proxy from following a compromised
          // upstream redirect into loopback, metadata, or another private
          // service.
          maxRedirects: 0,
        }
      );
      log.debug({ address: formattedAddress }, 'Tx history fetched');
      res.status(200).json(response.data);
    } catch (error) {
      const code = axios.isAxiosError(error) ? error.code : undefined;
      if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        log.warn({ address: formattedAddress, code }, 'Tx history upstream timeout');
        res.status(504).json({ message: 'Upstream timeout fetching tx history' });
        return;
      }
      log.error({ error, address: formattedAddress }, 'Failed to get tx history');
      res.status(500).json({ message: 'Failed to get tx history' });
    }
  })
);

export default appRouter;
