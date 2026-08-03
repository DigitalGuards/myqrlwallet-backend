import * as chai from 'chai';
import sinon from 'sinon';

const { expect } = chai;

import { errorHandler } from '../../src/middleware/error-handler.js';
import { logger } from '../../src/utils/logger.js';

describe('errorHandler', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('does not copy body-parser raw request data into logs', () => {
    const logStub = sinon.stub(logger, 'warn');
    const error = Object.assign(new SyntaxError('Malformed JSON'), {
      status: 400,
      body: '{"signedTransaction":"sensitive-wallet-data"',
    });
    const response = {
      headersSent: false,
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
    };

    errorHandler(error, {}, response, sinon.stub());

    expect(response.status.calledWith(400)).to.equal(true);
    expect(logStub.calledOnce).to.equal(true);
    expect(JSON.stringify(logStub.firstCall.args[0])).not.to.include('sensitive-wallet-data');
  });

  it('redacts JSON parser messages that embed request fragments', () => {
    const logStub = sinon.stub(logger, 'warn');
    const error = Object.assign(
      new SyntaxError('Unexpected token n in JSON at position 0 near notsecretseedmaterial'),
      {
        status: 400,
        type: 'entity.parse.failed',
        body: 'notsecretseedmaterial',
      }
    );
    const response = {
      headersSent: false,
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
    };

    errorHandler(error, {}, response, sinon.stub());

    const logged = JSON.stringify(logStub.firstCall.args[0]);
    const returned = JSON.stringify(response.json.firstCall.args[0]);
    expect(logged).not.to.include('notsecretseedmaterial');
    expect(returned).not.to.include('notsecretseedmaterial');
    expect(response.json.firstCall.args[0].error.message).to.equal('Invalid request body');
  });

  it('delegates errors after response headers have been sent', () => {
    const error = new Error('late stream failure');
    const next = sinon.stub();

    errorHandler(error, {}, { headersSent: true }, next);

    expect(next.calledOnceWithExactly(error)).to.equal(true);
  });
});
