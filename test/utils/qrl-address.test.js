import * as chai from 'chai';
import { createHash } from 'node:crypto';
import { isQrlAddress } from '../../src/utils/qrl-address.js';

const { expect } = chai;

const LOWER_BODY = 'ab'.repeat(64);

function checksummedBody(lower) {
  const hash = createHash('shake256', { outputLength: 64 }).update(lower, 'ascii').digest();
  let out = '';
  for (let i = 0; i < lower.length; i += 1) {
    const c = lower[i];
    if (c < 'a' || c > 'f') {
      out += c;
      continue;
    }
    const byte = hash[i >> 1];
    const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    out += nibble >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

describe('utils/qrl-address', () => {
  it('accepts uniform-case QIP-55 bodies without checksum information', () => {
    expect(isQrlAddress(`Q${LOWER_BODY}`)).to.equal(true);
    expect(isQrlAddress(`Q${LOWER_BODY.toUpperCase()}`)).to.equal(true);
    expect(isQrlAddress(`Q${'1234'.repeat(32)}`)).to.equal(true);
  });

  it('accepts exactly the SHAKE-256 checksummed mixed-case body', () => {
    expect(isQrlAddress(`Q${checksummedBody(LOWER_BODY)}`)).to.equal(true);
  });

  it('rejects a mixed-case body whose checksum casing is wrong', () => {
    const checksummed = checksummedBody(LOWER_BODY);
    const letterIndex = [...checksummed].findIndex((c) => /[a-fA-F]/.test(c));
    const flipped =
      checksummed.slice(0, letterIndex) +
      (checksummed[letterIndex] === checksummed[letterIndex].toLowerCase()
        ? checksummed[letterIndex].toUpperCase()
        : checksummed[letterIndex].toLowerCase()) +
      checksummed.slice(letterIndex + 1);
    expect(flipped).to.not.equal(checksummed);
    expect(isQrlAddress(`Q${flipped}`)).to.equal(false);
  });

  it('rejects near-miss widths, prefixes, and whitespace', () => {
    expect(isQrlAddress(`Q${'ab'.repeat(63)}ab`.slice(0, 128))).to.equal(false); // 127 hex
    expect(isQrlAddress(`Q${'ab'.repeat(64)}a`)).to.equal(false); // 129 hex
    expect(isQrlAddress(`q${LOWER_BODY}`)).to.equal(false);
    expect(isQrlAddress(`0x${LOWER_BODY}`)).to.equal(false);
    expect(isQrlAddress(` Q${LOWER_BODY}`)).to.equal(false);
    expect(isQrlAddress(`Q${'34'.repeat(20)}`)).to.equal(false); // legacy Q40
  });
});
