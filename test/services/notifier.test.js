import * as chai from 'chai';

const { expect } = chai;

import { redactEndpointForLogs } from '../../src/services/notifier.js';

describe('RPC health notifier', () => {
  it('removes endpoint credentials, paths, queries, and fragments from log labels', () => {
    const endpoint = 'https://wallet-user:secret@rpc.example/v1/api-key?token=secret#fragment';

    expect(redactEndpointForLogs(endpoint)).to.equal('https://rpc.example');
  });

  it('does not echo malformed endpoint configuration', () => {
    expect(redactEndpointForLogs('not a URL with secret data')).to.equal('[invalid RPC endpoint]');
  });
});
