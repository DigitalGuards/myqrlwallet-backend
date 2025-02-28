import express from 'express';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import { routes } from './routes/index.js';

const app = express();

// Middleware
app.use(express.json());
app.use(corsMiddleware);

// Routes
app.use(routes);

// Error handling
app.use(errorHandler);

export { app }; 