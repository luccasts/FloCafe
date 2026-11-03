const REQUEST_TIMEOUT_MS = 10_000;

type WhatsAppBotReplyErrorCode = 'not_configured' | 'invalid_url' | 'callback_failed';

export class WhatsAppBotReplyError extends Error {
  constructor(
    message: string,
    readonly code: WhatsAppBotReplyErrorCode,
  ) {
    super(message);
    this.name = 'WhatsAppBotReplyError';
  }
}

export async function sendHumanReplyToWhatsAppBot(
  phoneE164: string,
  body: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const rawUrl = env.WHATSAPP_BOT_REPLY_URL?.trim();
  const apiKey = env.WHATSAPP_BOT_REPLY_KEY?.trim();
  if (!rawUrl || !apiKey) {
    throw new WhatsAppBotReplyError(
      'WhatsApp bot reply callback is not configured',
      'not_configured',
    );
  }

  let url: URL;
  let authority: string;
  try {
    const schemeEnd = rawUrl.indexOf('://');
    if (schemeEnd < 1) throw new Error('missing authority');
    authority = rawUrl.slice(schemeEnd + 3).split(/[/?#]/, 1)[0];
    if (!authority) throw new Error('missing host');
    url = new URL(rawUrl);
  } catch {
    throw new WhatsAppBotReplyError('WhatsApp bot reply callback URL is invalid', 'invalid_url');
  }
  const rawHost = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : (() => {
        const portSeparator = authority.lastIndexOf(':');
        const port = authority.slice(portSeparator + 1);
        return portSeparator > 0 && [...port].every((char) => char >= '0' && char <= '9')
          ? authority.slice(0, portSeparator)
          : authority;
      })();
  const isLiteralLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(rawHost.toLowerCase());
  if (
    authority.includes('@') ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLiteralLoopback))
  ) {
    throw new WhatsAppBotReplyError(
      'WhatsApp bot reply callback URL must use HTTPS (HTTP is allowed only for loopback) and contain no credentials',
      'invalid_url',
    );
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phone_e164: phoneE164, body }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new WhatsAppBotReplyError(
      'WhatsApp bot reply callback request failed',
      'callback_failed',
    );
  }
  if (!response.ok) {
    throw new WhatsAppBotReplyError(
      `WhatsApp bot reply callback returned HTTP ${response.status}`,
      'callback_failed',
    );
  }
}
