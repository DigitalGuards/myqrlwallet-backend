import NodeCache from 'node-cache';
import { CONFIG } from '../config/index.js';

export const cache = new NodeCache({ stdTTL: CONFIG.CACHE_TTL }); 