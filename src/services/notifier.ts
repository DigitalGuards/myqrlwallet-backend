import { logger } from '../utils/logger.js';

export type NotifySeverity = 'info' | 'warn' | 'error' | 'critical';

export interface HealthEvent {
  severity?: NotifySeverity;
  network?: string;
  endpoint?: string;
  event: string;
  detail?: unknown;
}

const SEVERITY_TO_PINO: Record<NotifySeverity, 'info' | 'warn' | 'error'> = {
  info: 'info',
  warn: 'warn',
  error: 'error',
  critical: 'error',
};

/**
 * Single point through which the backend reports operational health events
 * (e.g. RPC endpoint flipping up/down/stalled). Today this is just a structured
 * log line; future Discord/Telegram/Sentry integrations slot in here without
 * touching call sites.
 *
 * Why a wrapper over plain logger.warn(): callers should not need to know that
 * routing is logger-only today. When alerting is added, behaviour changes once
 * here, not everywhere.
 */
export function notify({ severity = 'info', network, endpoint, event, detail }: HealthEvent): void {
  const level = SEVERITY_TO_PINO[severity];
  logger[level](
    {
      kind: 'rpc-health',
      severity,
      network,
      endpoint,
      event,
      detail,
    },
    `[rpc-health] ${event} ${endpoint ?? ''} (${network ?? 'n/a'})`.trim()
  );
}
