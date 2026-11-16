import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateRequest, validateResponse, negotiateV2, hashOrderIntent, replayDecision } from '../main/contracts/businessV2';
const fixtures = JSON.parse(readFileSync(require.resolve('../contract-v2/fixtures.json'), 'utf8'));
const context = {installationId:'installation-1', principal:{kind:'machine' as const, installationId:'installation-1',scopes:['catalog.view','orders.create','orders.read','integration.health'] as const},sessionId:'session-1',granted:['catalog.get_page','orders.create','orders.get_receipt','orders.get_status','integration.health'] as const};
const copy = (v:any):any => JSON.parse(JSON.stringify(v));
test('manifest pins local contract, fixtures and ADR bytes',()=>{
 const manifest = JSON.parse(readFileSync(require.resolve('../contract-v2/manifest.json'),'utf8'));
 for (const [name,expected] of Object.entries(manifest)) {
  const bytes=readFileSync(require.resolve(`../${name === 'businessV2.ts' ? 'main/contracts/businessV2.ts' : name}`));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,name);
 }
});
for (const op of ['catalog.get_page','orders.create','orders.get_receipt','orders.get_status','integration.health']) test(`${op}: positive contract`, () => {
 const {request,response}=fixtures[op];assert.equal(validateRequest(request,context).ok,true);assert.equal(validateResponse(response,request,context).ok,true);
});
test('outcome variants and mismatched correlation',()=>{
 for(const {request,response} of fixtures.outcomes) assert.equal(validateResponse(response,request,context).ok,true);
 const {request,response}=fixtures['orders.create'];
 for(const change of [{requestId:'wrong'},{sessionId:'old'},{operation:'orders.get_status'},{operationId:'wrong'}]) assert.equal(validateResponse({...response,...change},request,context).ok,false);
});
test('opaque IDs, catalog relationships and frozen general/item notes',()=>{
 const page=fixtures['catalog.get_page'];
 assert.equal(validateResponse(page.response,page.request,context).ok,true);
 assert.equal(validateResponse(fixtures['catalog.drink_page'].response,fixtures['catalog.drink_page'].request,context).ok,true);
 const intent=fixtures['orders.create'].request.payload.intent;
 assert.match(intent.items[0].note,/Sabores: Calabresa \+ Mussarela/);
 assert.match(intent.notes,/interfone/);
 assert.equal(intent.items[0].expectedUnitCents,page.response.result.products[0].variants[0].priceCents+page.response.result.groups[0].addons[0].priceCents);
 assert.notEqual(hashOrderIntent({...intent,notes:'outra observação'}),fixtures['orders.create'].request.payload.requestHash);
 for(const change of [
  (x:any)=>{x.payload.intent.items[0].productId=3},
  (x:any)=>{x.payload.intent.items[0].variantId=3},
  (x:any)=>{x.payload.intent.items[0].addonIds=[3]},
  (x:any)=>{x.payload.intent.paymentSelection.kind='card'},
 ]) {const x=copy(fixtures['orders.create'].request);change(x);assert.equal(validateRequest(x,context).ok,false)}
 for(const change of [
  (x:any)=>{x.result.products[0].id=3},
  (x:any)=>{x.result.products[0].variants[0].id=3},
  (x:any)=>{x.result.groups[0].addons[0].id=3},
  (x:any)=>{x.result.groups[0].minSelection=-1},
  (x:any)=>{x.result.products[0].groupIds=['same','same']},
 ]) {const x=copy(page.response);change(x);assert.equal(validateResponse(x,page.request,context).ok,false)}
 const withoutGroups=copy(page.response);withoutGroups.result.groups=[];
 assert.equal(validateResponse(withoutGroups,page.request,context).ok,true);
 const receipt=fixtures['orders.get_receipt'];const invalid=copy(receipt.response);invalid.result.receipt.posOrderId=42;
 assert.equal(validateResponse(invalid,receipt.request,context).ok,false);
});
test('schema rejects extra nested fields, identity forgery, scope omission, unsafe numbers and incorrect hash',()=>{
 const r=fixtures['orders.create'].request;
 for(const mutation of [
  (x:any)=>{x.payload.other=true},(x:any)=>{x.payload.intent.items[0].other=true},
  (x:any)=>{x.payload.intent.items[0].quantity=NaN},(x:any)=>{x.payload.intent.items[0].expectedUnitCents=1.2},
  (x:any)=>{x.payload.intent.items[0].productId=0},(x:any)=>{x.operationId='../bad'},
  (x:any)=>{x.payload.requestHash='a'.repeat(64)},(x:any)=>{x.installationId='forged'},
  (x:any)=>{x.principal={kind:'machine'}},(x:any)=>{x.payload.intent.customer.phoneE164='invalid'},
 ]) {const x=copy(r);mutation(x);assert.equal(validateRequest(x,context).ok,false)}
 assert.equal(validateRequest({...r,sessionId:'stale'},context).ok,false);
 assert.equal(validateRequest({...r,operation:'orders.cancel'},context).ok,false);
 assert.equal(validateRequest(r,{...context,principal:{...context.principal,scopes:[]}}).ok,false);
 assert.equal(validateRequest(Buffer.from(JSON.stringify(r)),context).ok,false);
 assert.equal(validateRequest('{',context).ok,false);
 assert.equal(validateRequest({type:'ready',protocol:1},context).ok,false);
 assert.equal(validateRequest({...r,payload:{...r.payload,intent:{...r.payload.intent,note:'é'.repeat(9000)}}},context).ok,false);
});
test('response rejects impossible outcome/results and nested extra fields',()=>{
 const {request,response}=fixtures['orders.create'];
 assert.equal(validateResponse({...response,outcome:'not_applied'},request,context).ok,false);
 assert.equal(validateResponse({...response,outcome:'unknown',result:null,errorCode:'raw customer address'},request,context).ok,false);
 assert.equal(validateResponse({...response,outcome:'unknown',result:null,errorCode:'unavailable'},request,context).ok,true);
 assert.equal(validateResponse({...response,outcome:'not_applied',result:null,errorCode:'not_found'},request,context).ok,false);
 assert.equal(validateResponse({...response,result:{...response.result,receipt:{...response.result.receipt,other:1}}},request,context).ok,false);
 assert.equal(validateResponse({...response,result:{...response.result,receipt:{...response.result.receipt,posOrderId:Number.MAX_SAFE_INTEGER+1}}},request,context).ok,false);
});
test('capabilities are negotiated intersection and v1 cannot grant',()=>{
 const args={peerVersion:2,peerSupported:['catalog.get_page','orders.create'] as const,localAllowed:['catalog.get_page','orders.create'] as const,principalScopes:['catalog.view'] as const,required:['catalog.get_page'] as const};
 assert.deepEqual(negotiateV2(args),{ok:true,granted:['catalog.get_page']});
 assert.equal(negotiateV2({...args,required:['orders.create']}).ok,false);
 assert.deepEqual(negotiateV2({...args,peerVersion:1,required:[]}),{ok:true,granted:[]});
});
test('new session and RPC ID keep order identity/hash, stale response is invalid',()=>{
 const {request,response}=fixtures['orders.create'];
 const retry={...request,requestId:'request-retry',sessionId:'session-2'};
 const next={...context,sessionId:'session-2'};
 assert.equal(validateRequest(retry,next).ok,true);
 assert.equal(retry.operationId,request.operationId);
 assert.equal(retry.payload.requestHash,request.payload.requestHash);
 assert.equal(validateResponse(response,retry,next).ok,false);
 assert.equal(replayDecision({state:'applied',requestHash:request.payload.requestHash},retry.payload.requestHash),'return_receipt');
 const changed={...request.payload.intent,expectedTotalCents:request.payload.intent.expectedTotalCents+1};
 assert.equal(replayDecision({state:'applied',requestHash:request.payload.requestHash},hashOrderIntent(changed)!),'conflict');
});
test('canonical order identity and pure replay classification',()=>{
 const i=fixtures['orders.create'].request.payload.intent;
 assert.equal(hashOrderIntent(Object.fromEntries(Object.entries(i).reverse())),hashOrderIntent(i));
 assert.notEqual(hashOrderIntent({...i,expectedTotalCents:i.expectedTotalCents+1}),hashOrderIntent(i));
 assert.equal(hashOrderIntent({...i,sessionId:'forged'}),null);
 assert.equal(replayDecision({state:'applied',requestHash:'a'},'a'),'return_receipt');
 assert.equal(replayDecision({state:'applied',requestHash:'b'},'a'),'conflict');
 assert.equal(replayDecision({state:'unknown'},'a'),'reconcile');
 assert.equal(replayDecision({state:'not_found'},'a'),'retry_same_identity_only_after_durable_idempotency');
});
