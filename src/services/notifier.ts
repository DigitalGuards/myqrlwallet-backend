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

export function redactEndpointForLogs(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) return undefined;
  try {
    const parsed = new URL(endpoint);
    return parsed.origin === 'null' ? '[redacted RPC endpoint]' : parsed.origin;
  } catch {
    return '[invalid RPC endpoint]';
  }
}

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
  const safeEndpoint = redactEndpointForLogs(endpoint);
  logger[level](
    {
      kind: 'rpc-health',
      severity,
      network,
      endpoint: safeEndpoint,
      event,
      detail,
    },
    `[rpc-health] ${event} ${safeEndpoint ?? ''} (${network ?? 'n/a'})`.trim()
  );
}
