import { CONFIG } from '../config/index.js';
import { timingSafeEqualStrings } from '../crypto/primitives.js';
import { healthMonitor } from './rpc/healthMonitor.js';
import { isRecord, toError } from '../utils/guards.js';
import { logger } from '../utils/logger.js';

interface TelegramRequest {
  method: string;
  payload: Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

async function isAuthorized(userId: number, chatId: number): Promise<boolean> {
  if (
    CONFIG.TELEGRAM_ALLOWED_USER_IDS.includes(String(userId)) ||
    CONFIG.TELEGRAM_ALLOWED_CHAT_IDS.includes(String(chatId))
  ) {
    return true;
  }
  if (chatId !== userId || !CONFIG.TELEGRAM_BOT_TOKEN) return false;

  for (const allowedChatId of CONFIG.TELEGRAM_ALLOWED_CHAT_IDS) {
    try {
      const response = await fetch(botApiUrl('getChatMember'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: allowedChatId, user_id: userId }),
        redirect: 'error',
      });
      if (!response.ok) continue;
      const body: unknown = await response.json();
      if (!isRecord(body) || body.ok !== true || !isRecord(body.result)) continue;
      const status = stringField(body.result, 'status');
      if (status === 'creator' || status === 'administrator') return true;
    } catch {
      continue;
    }
  }
  return false;
}

function botApiUrl(method: string): string {
  return `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function callTelegram({ method, payload }: TelegramRequest): Promise<void> {
  if (!CONFIG.TELEGRAM_BOT_TOKEN) return;
  const response = await fetch(botApiUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Telegram API ${method} returned HTTP ${response.status}`);
}

function miniAppButton(): Record<string, unknown> | null {
  if (!CONFIG.TELEGRAM_MINI_APP_URL.startsWith('https://')) return null;
  return { text: 'Open control center', web_app: { url: CONFIG.TELEGRAM_MINI_APP_URL } };
}

function homeKeyboard(): Record<string, unknown> {
  const rows: unknown[][] = [
    [
      { text: 'System status', callback_data: 'status' },
      { text: 'Security', callback_data: 'security' },
    ],
  ];
  const appButton = miniAppButton();
  if (appButton) rows.unshift([appButton]);
  return { inline_keyboard: rows };
}

function statusText(): string {
  const snapshot = healthMonitor.getSnapshot();
  const lines = Object.entries(snapshot).map(([network, endpoints]) => {
    const best = endpoints.find((endpoint) => endpoint.state === 'up') ?? endpoints[0];
    if (!best) return `${network}: unavailable`;
    const height = best.lastHeight === null ? 'waiting for height' : `block ${best.lastHeight}`;
    const latency = best.lastLatencyMs === null ? '' : `, ${best.lastLatencyMs} ms`;
    return `${network}: ${best.state}, ${height}${latency}`;
  });
  return ['MyQRLWallet system status', '', ...lines].join('\n');
}

async function sendHome(chatId: number): Promise<void> {
  await callTelegram({
    method: 'sendMessage',
    payload: {
      chat_id: chatId,
      text: 'MyQRLWallet control center\n\nChoose an action below. Wallet secrets and signing stay inside MyQRLWallet.',
      reply_markup: homeKeyboard(),
    },
  });
}

async function sendStatus(chatId: number): Promise<void> {
  await callTelegram({
    method: 'sendMessage',
    payload: {
      chat_id: chatId,
      text: statusText(),
      reply_markup: homeKeyboard(),
    },
  });
}

async function handleCallback(callback: Record<string, unknown>, userId: number): Promise<void> {
  const callbackId = stringField(callback, 'id');
  const data = stringField(callback, 'data');
  const message = callback.message;
  if (callbackId) {
    await callTelegram({
      method: 'answerCallbackQuery',
      payload: { callback_query_id: callbackId },
    });
  }
  if (!isRecord(message)) return;
  const chat = message.chat;
  if (!isRecord(chat)) return;
  const chatId = numberField(chat, 'id');
  if (chatId === null || !(await isAuthorized(userId, chatId))) return;
  if (data === 'status') {
    await sendStatus(chatId);
  } else if (data === 'security') {
    await callTelegram({
      method: 'sendMessage',
      payload: {
        chat_id: chatId,
        text: 'Security reminder\n\nNever send a seed, mnemonic, private key, PIN, or wallet file to this bot. Transaction signing only happens inside MyQRLWallet.',
        reply_markup: homeKeyboard(),
      },
    });
  }
}

export function verifyTelegramWebhookSecret(provided: string): boolean {
  return (
    Boolean(CONFIG.TELEGRAM_WEBHOOK_SECRET) &&
    timingSafeEqualStrings(CONFIG.TELEGRAM_WEBHOOK_SECRET, provided)
  );
}

export async function handleTelegramUpdate(update: unknown): Promise<void> {
  if (!isRecord(update)) return;
  const callback = update.callback_query;
  if (isRecord(callback) && isRecord(callback.from)) {
    const userId = numberField(callback.from, 'id');
    if (userId !== null) await handleCallback(callback, userId);
    return;
  }

  const message = update.message;
  if (!isRecord(message) || !isRecord(message.from) || !isRecord(message.chat)) return;
  const userId = numberField(message.from, 'id');
  const chatId = numberField(message.chat, 'id');
  const text = stringField(message, 'text')?.trim().toLowerCase();
  if (userId === null || chatId === null || !(await isAuthorized(userId, chatId))) return;

  if (text === '/status') await sendStatus(chatId);
  else await sendHome(chatId);
}

export async function configureTelegramBot(): Promise<void> {
  if (!CONFIG.TELEGRAM_BOT_TOKEN) {
    logger.info('Telegram bot disabled: TELEGRAM_BOT_TOKEN is unset');
    return;
  }
  const requests: TelegramRequest[] = [
    {
      method: 'setMyCommands',
      payload: {
        commands: [
          { command: 'start', description: 'Open the control center' },
          { command: 'menu', description: 'Show the main menu' },
          { command: 'status', description: 'Check service health' },
        ],
      },
    },
  ];
  const appButton = miniAppButton();
  if (appButton) {
    requests.push({
      method: 'setChatMenuButton',
      payload: { menu_button: { type: 'web_app', ...appButton } },
    });
  }
  if (CONFIG.TELEGRAM_WEBHOOK_URL.startsWith('https://') && CONFIG.TELEGRAM_WEBHOOK_SECRET) {
    requests.push({
      method: 'setWebhook',
      payload: {
        url: CONFIG.TELEGRAM_WEBHOOK_URL,
        secret_token: CONFIG.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
      },
    });
  }
  try {
    await Promise.all(requests.map(callTelegram));
    logger.info('Telegram bot menu and webhook configured');
  } catch (error) {
    logger.error({ err: toError(error) }, 'Telegram bot configuration failed');
  }
}

export async function broadcastTelegramAlert(message: string): Promise<void> {
  if (!CONFIG.TELEGRAM_BOT_TOKEN) return;
  const recipients = Array.from(
    new Set([...CONFIG.TELEGRAM_ALLOWED_CHAT_IDS, ...CONFIG.TELEGRAM_ALLOWED_USER_IDS])
  );
  await Promise.all(
    recipients.map((chatId) =>
      callTelegram({
        method: 'sendMessage',
        payload: {
          chat_id: chatId,
          text: message.slice(0, 4096),
          reply_markup: homeKeyboard(),
        },
      })
    )
  );
}

export function telegramConfigStatus(): {
  enabled: boolean;
  miniApp: boolean;
  allowlisted: boolean;
} {
  return {
    enabled: Boolean(CONFIG.TELEGRAM_BOT_TOKEN),
    miniApp: Boolean(miniAppButton()),
    allowlisted:
      CONFIG.TELEGRAM_ALLOWED_USER_IDS.length > 0 || CONFIG.TELEGRAM_ALLOWED_CHAT_IDS.length > 0,
  };
}
