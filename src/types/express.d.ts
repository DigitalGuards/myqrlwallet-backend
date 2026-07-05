/**
 * Express request augmentation. `rpcMethodType` is stamped by the
 * rpcMethodWhitelist middleware and consumed by the tiered rate limiters.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rpcMethodType?: 'read' | 'write';
    }
  }
}

export {};
