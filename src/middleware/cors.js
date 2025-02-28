import cors from 'cors';
import { CONFIG } from '../config/index.js';

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin || CONFIG.ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}); 