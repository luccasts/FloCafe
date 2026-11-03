import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export function isWhatsAppInboundRequest(req: Request): boolean {
  const result = req.method === 'POST' && req.originalUrl.split('?')[0] === '/api/whatsapp/inbound';
  return result;
}

export function isWhatsAppTakeoverStateRequest(req: Request): boolean {
  const path = req.originalUrl.split('?')[0];
  return req.method === 'GET' && /^\/api\/whatsapp\/takeover\/(?:%2B|\+)[1-9][0-9]{7,14}$/i.test(path);
}

export function requireWhatsAppServiceKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.FLOCAFE_INBOX_SERVICE_KEY;
  const supplied = req.headers['x-flocafe-inbox-key'];
  if (
    !(isWhatsAppInboundRequest(req) || isWhatsAppTakeoverStateRequest(req)) ||
    !expected ||
    !/^[0-9a-f]{64}$/.test(expected) ||
    typeof supplied !== 'string' ||
    !/^[0-9a-f]{64}$/.test(supplied) ||
    !timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(supplied, 'ascii'))
  ) {
    res
      .status(401)
      .json({ error: 'Invalid or missing inbox service key', code: 'authentication_required' });
    return;
  }
  if (isWhatsAppTakeoverStateRequest(req)) {
    res.locals.whatsappTakeoverServiceAuthorized = true;
  }
  next();
}
