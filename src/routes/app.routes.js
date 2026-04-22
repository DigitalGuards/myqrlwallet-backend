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

appRouter.post('/tx-history', txHistoryRateLimit, async (req, res) => {
  const { address, page = 1, limit = 5 } = req.body;

  // Validate address format (Q + 40 hex chars)
  if (!address || typeof address !== 'string' || !/^Q[a-fA-F0-9]{40}$/i.test(address)) {
    return res.status(400).json({ message: 'Invalid address format' });
  }

  const formattedAddress = 'Q' + address.slice(1).toLowerCase();
  axios
    .get(`https://zondscan.com/api/address/${formattedAddress}/transactions`, {
      params: {
        page: page,
        limit: limit,
      },
    })
    .then((response) => {
      log.debug({ address: formattedAddress }, 'Tx history fetched');
      res.status(200).json(response.data);
    })
    .catch((error) => {
      log.error({ error, address: formattedAddress }, 'Failed to get tx history');
      res.status(500).json({ message: 'Failed to get tx history' });
    });
});

export default appRouter;
