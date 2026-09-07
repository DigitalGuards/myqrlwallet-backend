import * as chai from 'chai';
import { default as chaiHttp, request } from 'chai-http';
import sinon from 'sinon';
import { app } from '../../src/app.js';
import { CONFIG } from '../../src/config/index.js';

chai.use(chaiHttp);
const { expect } = chai;

describe('Telegram routes', () => {
  const original = {
    token: CONFIG.TELEGRAM_BOT_TOKEN,
    secret: CONFIG.TELEGRAM_WEBHOOK_SECRET,
    allowed: [...CONFIG.TELEGRAM_ALLOWED_USER_IDS],
    allowedChats: [...CONFIG.TELEGRAM_ALLOWED_CHAT_IDS],
  };

  afterEach(() => {
    CONFIG.TELEGRAM_BOT_TOKEN = original.token;
    CONFIG.TELEGRAM_WEBHOOK_SECRET = original.secret;
    CONFIG.TELEGRAM_ALLOWED_USER_IDS = [...original.allowed];
    CONFIG.TELEGRAM_ALLOWED_CHAT_IDS = [...original.allowedChats];
    sinon.restore();
  });

  it('rejects webhook requests without the configured secret', async () => {
    CONFIG.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
    const res = await request.execute(app).post('/api/telegram/webhook').send({ update_id: 1 });
    expect(res).to.have.status(401);
  });

  it('accepts an authenticated update and sends the menu', async () => {
    CONFIG.TELEGRAM_BOT_TOKEN = '123:test-token';
    CONFIG.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
    CONFIG.TELEGRAM_ALLOWED_USER_IDS = ['42'];
    CONFIG.TELEGRAM_ALLOWED_CHAT_IDS = [];
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response('{}', { status: 200 }));

    const res = await request
      .execute(app)
      .post('/api/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', 'test-secret')
      .send({
        update_id: 1,
        message: { message_id: 1, from: { id: 42 }, chat: { id: 42 }, text: '/start' },
      });

    expect(res).to.have.status(200);
    expect(fetchStub.callCount).to.equal(1);
    expect(fetchStub.firstCall.args[0]).to.equal(
      'https://api.telegram.org/bot123:test-token/sendMessage'
    );
  });

  it('ignores users outside the allowlist', async () => {
    CONFIG.TELEGRAM_BOT_TOKEN = '123:test-token';
    CONFIG.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
    CONFIG.TELEGRAM_ALLOWED_USER_IDS = ['42'];
    CONFIG.TELEGRAM_ALLOWED_CHAT_IDS = [];
    const fetchStub = sinon.stub(globalThis, 'fetch');

    const res = await request
      .execute(app)
      .post('/api/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', 'test-secret')
      .send({
        update_id: 1,
        message: { message_id: 1, from: { id: 7 }, chat: { id: 7 }, text: '/start' },
      });

    expect(res).to.have.status(200);
    expect(fetchStub.callCount).to.equal(0);
  });

  it('accepts messages from an allowed private group', async () => {
    CONFIG.TELEGRAM_BOT_TOKEN = '123:test-token';
    CONFIG.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
    CONFIG.TELEGRAM_ALLOWED_USER_IDS = [];
    CONFIG.TELEGRAM_ALLOWED_CHAT_IDS = ['-1001234567890'];
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response('{}', { status: 200 }));

    const res = await request
      .execute(app)
      .post('/api/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', 'test-secret')
      .send({
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 7 },
          chat: { id: -1001234567890 },
          text: '/menu',
        },
      });

    expect(res).to.have.status(200);
    expect(fetchStub.callCount).to.equal(1);
    const requestBody = JSON.parse(fetchStub.firstCall.args[1].body);
    expect(JSON.stringify(requestBody.reply_markup)).not.to.include('web_app');
  });

  it('accepts a direct chat from an administrator of an allowed group', async () => {
    CONFIG.TELEGRAM_BOT_TOKEN = '123:test-token';
    CONFIG.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
    CONFIG.TELEGRAM_ALLOWED_USER_IDS = [];
    CONFIG.TELEGRAM_ALLOWED_CHAT_IDS = ['-1001234567890'];
    const fetchStub = sinon
      .stub(globalThis, 'fetch')
      .onFirstCall()
      .resolves(
        new Response(JSON.stringify({ ok: true, result: { status: 'administrator' } }), {
          status: 200,
        })
      );
    fetchStub.onSecondCall().resolves(new Response('{}', { status: 200 }));

    const res = await request
      .execute(app)
      .post('/api/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', 'test-secret')
      .send({
        update_id: 1,
        message: { message_id: 1, from: { id: 42 }, chat: { id: 42 }, text: '/start' },
      });

    expect(res).to.have.status(200);
    expect(fetchStub.callCount).to.equal(2);
    expect(fetchStub.firstCall.args[0]).to.equal(
      'https://api.telegram.org/bot123:test-token/getChatMember'
    );
  });
});
