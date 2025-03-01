import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

export const CONFIG = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  CACHE_TTL: parseInt(process.env.CACHE_TTL || '10', 10),
  
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .filter(origin => origin.length > 0),
    
  RPC_ENDPOINTS: {
    dev: process.env.RPC_ENDPOINT_DEV || 'http://localhost:8545',
    testnet: process.env.RPC_ENDPOINT_TESTNET || 'http://35.158.17.89:32837',
    mainnet: process.env.RPC_ENDPOINT_MAINNET || 'http://35.158.17.89:32837',
    custom: 'CUSTOM_RPC_URL'
  }
}; 