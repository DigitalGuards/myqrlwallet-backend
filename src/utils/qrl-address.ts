export const QRL_ADDRESS_HEX_LENGTH = 128;
export const QRL_ADDRESS_FORMAT = `Q + ${QRL_ADDRESS_HEX_LENGTH} hex chars`;

const QRL_ADDRESS_PATTERN = new RegExp(`^Q[0-9a-fA-F]{${QRL_ADDRESS_HEX_LENGTH}}$`);

import { hasValidCase } from '../crypto/qip55-checksum.js';

export function isQrlAddress(value: unknown): value is string {
  return (
    typeof value === 'string' && QRL_ADDRESS_PATTERN.test(value) && hasValidCase(value.slice(1))
  );
}
