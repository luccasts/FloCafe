import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportOrderOperationalFailure } from '../main/lib/order-operational-privacy';

const original = console.error;
const calls: unknown[][] = [];
console.error = (...args: unknown[]) => { calls.push(args); };
try {
  const secret = new Error('Rua Ficticia 123 +5511999999999 TOKEN_FICTICIO QR_FICTICIO');
  (secret as Error & { code: string }).code = 'TOKEN_FICTICIO';
  reportOrderOperationalFailure('create', secret, true);
  reportOrderOperationalFailure('append', secret, false);
  assert.deepEqual(calls.map(call => call[1]), [
    { operation: 'create', code: 'order_operation_failed', operationCommitted: true },
    { operation: 'append', code: 'order_operation_failed', operationCommitted: false },
  ]);
  assert.equal(JSON.stringify(calls).includes('TOKEN_FICTICIO'), false);
  assert.equal(JSON.stringify(calls).includes('5511999999999'), false);
  const source = readFileSync(join(__dirname, '../main/routes/orders.ts'), 'utf8');
  assert.match(source, /reportOrderOperationalFailure\('create', error, operationCommitted\)/);
  assert.match(source, /reportOrderOperationalFailure\('append', error, operationCommitted\)/);
  assert.match(source, /reportOrderOperationalFailure\('discount', error, operationCommitted\)/);
  assert.doesNotMatch(source, /console\.error\('\[Orders\] Tag sync failed:', err\)/);
  console.log('operational privacy: 7 assertions passed');
} finally { console.error = original; }
