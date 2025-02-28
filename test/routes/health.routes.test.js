import * as chai from "chai";

import {default as chaiHttp, request} from "chai-http";
chai.use(chaiHttp);

import { app } from '../../src/app.js';

chai.use(chaiHttp);
const { expect } = chai;

describe('Health Routes', () => {
  it('should return status ok', async () => {
    const res = await request.execute(app).get('/health');
    expect(res).to.have.status(200);
    expect(res.body).to.deep.equal({ status: 'ok' });
  });
});