import { createHash } from 'node:crypto';

export const BUSINESS_V2_OPERATIONS = ['catalog.get_page', 'orders.create', 'orders.get_receipt', 'orders.get_status', 'integration.health'] as const;
export type Operation = typeof BUSINESS_V2_OPERATIONS[number];
export type Scope = 'catalog.view' | 'orders.create' | 'orders.read' | 'integration.health';
export type Outcome = 'applied' | 'not_applied' | 'unknown' | 'conflict';
export type Result<T> = { ok: true; value: T } | { ok: false; code: 'invalid_frame' | 'unauthorized' | 'unsupported_operation' | 'correlation_mismatch' };
export type MachinePrincipal = { kind: 'machine'; installationId: string; scopes: readonly Scope[] };
export type TrustedContext = { installationId: string; principal: MachinePrincipal; sessionId: string; granted: readonly Operation[] };
export type CatalogProduct = { id: string; name: string; sku: string | null; categoryName: string | null; priceCents: number; active: boolean; variants: { id: string; name: string; priceCents: number; active: boolean }[]; groupIds: string[] };
export type CatalogGroup = { id: string; name: string; active: boolean; required: boolean; minSelection: number; maxSelection: number | null; addons: { id: string; name: string; priceCents: number; active: boolean }[] };
export type OrderIntent = {
  externalOrderId: string; items: { productId: string; variantId: string | null; addonIds: string[]; quantity: number; expectedUnitCents: number; note: string }[]; notes: string;
  fulfillment: { kind: 'delivery'; address: string; expectedDeliveryCents: number } | { kind: 'pickup' };
  customer: { name: string; phoneE164: string }; paymentSelection: { kind: 'cash' | 'pix' }; expectedTotalCents: number;
};
type BaseRequest<O extends Operation, P> = { type: 'request'; protocol: 2; requestId: string; sessionId: string; operation: O; payload: P };
export type BusinessRequest =
  | BaseRequest<'catalog.get_page', { snapshotId: string | null; cursor: string | null; limit: number }>
  | (BaseRequest<'orders.create', { payloadVersion: 1; requestHash: string; intent: OrderIntent }> & { operationId: string })
  | BaseRequest<'orders.get_receipt', { operationId: string; externalOrderId: string }>
  | BaseRequest<'orders.get_status', { operationId: string; externalOrderId: string }>
  | BaseRequest<'integration.health', Record<string, never>>;
type Receipt = { operationId: string; externalOrderId: string; requestHash: string; posOrderId: string; receiptId: string; status: string };
export type ErrorCode = 'validation_failed' | 'quote_changed' | 'unavailable' | 'conflict' | 'receipt_pending' | 'snapshot_expired' | 'not_found' | 'internal_error';
type ResponseBase<O extends Operation> = { type: 'response'; protocol: 2; requestId: string; sessionId: string; operation: O };
type Unknown<O extends Operation> = ResponseBase<O> & { outcome: 'unknown'; errorCode: 'unavailable' | 'internal_error'; result: null };
type Lookup<O extends 'orders.get_receipt' | 'orders.get_status', R> =
  | (ResponseBase<O> & { outcome: 'applied'; result: R })
  | (ResponseBase<O> & { outcome: 'not_applied'; errorCode: 'not_found'; result: {state:'not_found'} })
  | (ResponseBase<O> & { outcome: 'not_applied'; errorCode: 'receipt_pending'; result: {state:'pending'} })
  | Unknown<O>;
export type BusinessResponse =
  | (ResponseBase<'catalog.get_page'> & { outcome:'applied'; result:{state:'page';snapshotId:string;revision:string;nextCursor:string|null;products:CatalogProduct[];groups:CatalogGroup[]} })
  | (ResponseBase<'catalog.get_page'> & { outcome:'not_applied';errorCode:'snapshot_expired';result:{state:'expired'} })
  | Unknown<'catalog.get_page'>
  | (ResponseBase<'orders.create'> & {operationId:string} & (
      | {outcome:'applied';result:{state:'receipt';receipt:Receipt}}
      | {outcome:'not_applied';errorCode:'validation_failed'|'quote_changed';result:null}
      | {outcome:'conflict';errorCode:'conflict';result:null}
      | {outcome:'unknown';errorCode:'unavailable'|'internal_error';result:null}))
  | Lookup<'orders.get_receipt',{state:'found';receipt:Receipt}>
  | Lookup<'orders.get_status',{state:'found';status:string;posOrderId:string}>
  | (ResponseBase<'integration.health'> & {outcome:'applied';result:{state:'ready';supported:Operation[]}})
  | (ResponseBase<'integration.health'> & {outcome:'not_applied';errorCode:'unavailable';result:null})
  | Unknown<'integration.health'>;

const scopes: Record<Operation, Scope> = {
  'catalog.get_page': 'catalog.view', 'orders.create': 'orders.create',
  'orders.get_receipt': 'orders.read', 'orders.get_status': 'orders.read', 'integration.health': 'integration.health',
};
const ops = new Set<string>(BUSINESS_V2_OPERATIONS);
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const keys = (v: unknown, names: string[]): v is Record<string, unknown> => plain(v) && Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n));
const text = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
const posId = (v: unknown): v is string => text(v,128) && (v as string).trim().length > 0;
const note = (v: unknown): v is string => typeof v === 'string' && v.length <= 500 && text(v || ' ',501);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v);
const pos = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const cents = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 100_000_000;
const nullableId = (v: unknown): boolean => v === null || id(v);
const phone = (v: unknown): boolean => typeof v === 'string' && /^\+[1-9][0-9]{7,14}$/.test(v);
const hash = (v: unknown): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const orderRef = (v: unknown): boolean => id(v);
const limitedJson = (v: unknown, depth = 0): boolean => {
  if (depth > 12) return false;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v) && Number.isSafeInteger(v);
  if (Array.isArray(v)) return v.length <= 100 && v.every(x => limitedJson(x, depth + 1));
  return plain(v) && Object.keys(v).length <= 30 && Object.entries(v).every(([k, x]) => k !== '__proto__' && k !== 'constructor' && limitedJson(x, depth + 1));
};
const bounded = (v: unknown): boolean => limitedJson(v) && Buffer.byteLength(JSON.stringify(v), 'utf8') <= 16 * 1024;
function validIntent(i: unknown): i is OrderIntent {
  if (!keys(i, ['externalOrderId','items','notes','fulfillment','customer','paymentSelection','expectedTotalCents']) || !orderRef(i.externalOrderId) || !cents(i.expectedTotalCents) || !note(i.notes)) return false;
  if (!Array.isArray(i.items) || i.items.length < 1 || i.items.length > 30 || !i.items.every(item => keys(item, ['productId','variantId','addonIds','quantity','expectedUnitCents','note']) && posId(item.productId) && (item.variantId === null || posId(item.variantId)) && Array.isArray(item.addonIds) && item.addonIds.length <= 20 && item.addonIds.every(posId) && new Set(item.addonIds).size === item.addonIds.length && pos(item.quantity) && item.quantity <= 99 && cents(item.expectedUnitCents) && note(item.note))) return false;
  if (!plain(i.fulfillment) || !('kind' in i.fulfillment)) return false;
  if (i.fulfillment.kind === 'delivery') {
    if (!keys(i.fulfillment,['kind','address','expectedDeliveryCents']) || !text(i.fulfillment.address,500) || !cents(i.fulfillment.expectedDeliveryCents)) return false;
  } else if (i.fulfillment.kind !== 'pickup' || !keys(i.fulfillment,['kind'])) return false;
  return keys(i.customer,['name','phoneE164']) && text(i.customer.name,120) && phone(i.customer.phoneE164) && keys(i.paymentSelection,['kind']) && ['cash','pix'].includes(i.paymentSelection.kind as string);
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (plain(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export function hashOrderIntent(intent: unknown): string | null {
  if (!bounded(intent) || !validIntent(intent)) return null;
  return createHash('sha256').update(canonical(intent), 'utf8').digest('hex');
}
function validReceipt(v: unknown, external: unknown, operationId: unknown, requestHash?: unknown): boolean {
  return keys(v,['operationId','externalOrderId','requestHash','posOrderId','receiptId','status']) && v.operationId === operationId && v.externalOrderId === external && (requestHash === undefined || v.requestHash === requestHash) && hash(v.requestHash) && posId(v.posOrderId) && id(v.receiptId) && text(v.status,64);
}
const distinct = (values: unknown[], max: number): boolean => values.length <= max && values.every(posId) && new Set(values).size === values.length;
const option = (v: unknown): boolean => keys(v,['id','name','priceCents','active']) && posId(v.id) && text(v.name,120) && cents(v.priceCents) && typeof v.active === 'boolean';
function validProduct(v: unknown): boolean {
  return keys(v,['id','name','sku','categoryName','priceCents','active','variants','groupIds']) && posId(v.id) && text(v.name,120)
    && (v.sku === null || text(v.sku,128)) && (v.categoryName === null || text(v.categoryName,120)) && cents(v.priceCents) && typeof v.active === 'boolean'
    && Array.isArray(v.variants) && v.variants.length <= 100 && v.variants.every(option) && distinct(v.variants.map(x => x.id),100)
    && Array.isArray(v.groupIds) && distinct(v.groupIds,100);
}
function validGroup(v: unknown): boolean {
  return keys(v,['id','name','active','required','minSelection','maxSelection','addons']) && posId(v.id) && text(v.name,120)
    && typeof v.active === 'boolean' && typeof v.required === 'boolean' && Number.isSafeInteger(v.minSelection) && (v.minSelection as number) >= 0 && (v.minSelection as number) <= 100
    && (v.maxSelection === null || (Number.isSafeInteger(v.maxSelection) && (v.maxSelection as number) >= (v.minSelection as number) && (v.maxSelection as number) <= 100))
    && Array.isArray(v.addons) && v.addons.length <= 100 && v.addons.every(option) && distinct(v.addons.map(x => x.id),100);
}
function validPayload(op: Operation, p: unknown): boolean {
  switch(op) {
    case 'catalog.get_page': return keys(p,['snapshotId','cursor','limit']) && nullableId(p.snapshotId) && nullableId(p.cursor) && Number.isSafeInteger(p.limit) && (p.limit as number) >= 1 && (p.limit as number) <= 25 && (p.snapshotId !== null || p.cursor === null);
    case 'orders.create': return keys(p,['payloadVersion','requestHash','intent']) && p.payloadVersion === 1 && hash(p.requestHash) && validIntent(p.intent) && hashOrderIntent(p.intent) === p.requestHash;
    case 'orders.get_receipt': case 'orders.get_status': return keys(p,['operationId','externalOrderId']) && id(p.operationId) && orderRef(p.externalOrderId);
    case 'integration.health': return keys(p,[]);
  }
}
const failure = (code: Extract<Result<never>, {ok:false}>['code']): Result<never> => ({ok:false,code});
export function validateRequest(input: unknown, context: TrustedContext): Result<BusinessRequest> {
  if (!bounded(input) || !plain(input)) return failure('invalid_frame');
  const op = input.operation;
  if (!ops.has(op as string)) return failure('unsupported_operation');
  if (!keys(input, op === 'orders.create' ? ['type','protocol','requestId','sessionId','operation','operationId','payload'] : ['type','protocol','requestId','sessionId','operation','payload']) || input.type !== 'request' || input.protocol !== 2 || !id(input.requestId) || !id(input.sessionId) || (op === 'orders.create' && !id(input.operationId)) || !validPayload(op as Operation,input.payload)) return failure('invalid_frame');
  if (context.principal.kind !== 'machine' || !id(context.installationId) || context.principal.installationId !== context.installationId || !id(context.sessionId) || input.sessionId !== context.sessionId || !context.granted.includes(op as Operation) || !context.principal.scopes.includes(scopes[op as Operation])) return failure('unauthorized');
  return {ok:true,value:input as BusinessRequest};
}
function validResponseResult(r: Record<string,unknown>, req: BusinessRequest): boolean {
  const p = req.payload as Record<string,unknown>;
  if (r.outcome === 'unknown') return r.result === null;
  if (r.outcome === 'conflict') return req.operation === 'orders.create' && r.result === null;
  if (r.outcome === 'not_applied') {
    const code = r.errorCode;
    if (req.operation === 'orders.create' && code !== 'validation_failed' && code !== 'quote_changed') return false;
    if (req.operation === 'catalog.get_page' && code !== 'snapshot_expired') return false;
    if ((req.operation === 'orders.get_receipt' || req.operation === 'orders.get_status') && code !== ((r.result as {state?:unknown} | null)?.state === 'pending' ? 'receipt_pending' : 'not_found')) return false;
    if (req.operation === 'integration.health' && code !== 'unavailable') return false;
  }
  const v = r.result;
  if (req.operation === 'orders.create') return r.outcome === 'not_applied' ? v === null : keys(v,['state','receipt']) && v.state === 'receipt' && validReceipt(v.receipt,p.intent && (p.intent as OrderIntent).externalOrderId,req.operationId,p.requestHash);
  if (req.operation === 'catalog.get_page') {
    if (r.outcome === 'not_applied') return keys(v,['state']) && v.state === 'expired';
    return keys(v,['state','snapshotId','revision','nextCursor','products','groups']) && v.state === 'page' && id(v.snapshotId) && id(v.revision) && nullableId(v.nextCursor)
      && Array.isArray(v.products) && v.products.length <= (p.limit as number) && v.products.every(validProduct) && distinct(v.products.map(x => x.id),25)
      && Array.isArray(v.groups) && v.groups.length <= 100 && v.groups.every(validGroup) && distinct(v.groups.map(x => x.id),100)
      && (p.snapshotId === null || p.snapshotId === v.snapshotId);
  }
  if (req.operation === 'integration.health') return r.outcome === 'not_applied' ? v === null : keys(v,['state','supported']) && ['ready'].includes(v.state as string) && Array.isArray(v.supported) && v.supported.length <= BUSINESS_V2_OPERATIONS.length && v.supported.every(x => ops.has(x)) && new Set(v.supported).size === v.supported.length;
  if (r.outcome === 'not_applied') return keys(v,['state']) && (v.state === 'not_found' || v.state === 'pending');
  if (req.operation === 'orders.get_receipt') return keys(v,['state','receipt']) && v.state === 'found' && validReceipt(v.receipt,p.externalOrderId,p.operationId);
  return keys(v,['state','status','posOrderId']) && v.state === 'found' && text(v.status,64) && posId(v.posOrderId);
}
export function validateResponse(input: unknown, request: BusinessRequest, context: TrustedContext): Result<BusinessResponse> {
  if (!bounded(input) || !plain(input) || !['applied','not_applied','unknown','conflict'].includes(input.outcome as string)) return failure('invalid_frame');
  if (input.requestId !== request.requestId || input.sessionId !== request.sessionId || input.operation !== request.operation || (request.operation === 'orders.create' && input.operationId !== request.operationId)) return failure('correlation_mismatch');
  const hasError = input.outcome !== 'applied';
  const allowedCodes: readonly ErrorCode[] = ['validation_failed','quote_changed','unavailable','conflict','receipt_pending','snapshot_expired','not_found','internal_error'];
  if (hasError && (!allowedCodes.includes(input.errorCode as ErrorCode) || (input.outcome === 'conflict' && input.errorCode !== 'conflict') || (input.outcome === 'unknown' && input.errorCode !== 'unavailable' && input.errorCode !== 'internal_error'))) return failure('invalid_frame');
  if (!keys(input,request.operation === 'orders.create' ? ['type','protocol','requestId','sessionId','operation','operationId','outcome','result',...(hasError ? ['errorCode'] : [])] : ['type','protocol','requestId','sessionId','operation','outcome','result',...(hasError ? ['errorCode'] : [])]) || input.type !== 'response' || input.protocol !== 2 || !validResponseResult(input,request)) return failure('invalid_frame');
  if (!validateRequest(request,context).ok) return failure('unauthorized');
  return {ok:true,value:input as BusinessResponse};
}
export function negotiateV2(input: { peerVersion: number; peerSupported: readonly Operation[]; localAllowed: readonly Operation[]; principalScopes: readonly Scope[]; required: readonly Operation[] }): {ok:true;granted:Operation[]} | {ok:false;code:'capabilities_insufficient'|'invalid_negotiation';granted:Operation[]} {
  if (![1,2].includes(input.peerVersion) || ![input.peerSupported,input.localAllowed,input.principalScopes,input.required].every(Array.isArray) || ![...input.peerSupported,...input.localAllowed,...input.required].every(x => ops.has(x)) || !input.principalScopes.every(x => Object.values(scopes).includes(x))) return {ok:false,code:'invalid_negotiation',granted:[]};
  const granted = input.peerVersion === 2 ? BUSINESS_V2_OPERATIONS.filter(x => input.peerSupported.includes(x) && input.localAllowed.includes(x) && input.principalScopes.includes(scopes[x])) : [];
  return input.required.every(x => granted.includes(x)) ? {ok:true,granted} : {ok:false,code:'capabilities_insufficient',granted};
}
export function replayDecision(prior: {state:'applied';requestHash:string} | {state:'unknown'|'not_found'}, requestHash: string): 'return_receipt'|'conflict'|'reconcile'|'retry_same_identity_only_after_durable_idempotency' {
  if (prior.state === 'applied') return prior.requestHash === requestHash ? 'return_receipt' : 'conflict';
  return prior.state === 'unknown' ? 'reconcile' : 'retry_same_identity_only_after_durable_idempotency';
}
