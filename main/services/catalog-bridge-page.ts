import { createHash, randomBytes } from 'node:crypto';
import { validateResponse, type BusinessRequest, type BusinessResponse, type CatalogProduct, type CatalogGroup, type TrustedContext } from '../contracts/businessV2';

type CatalogRequest = Extract<BusinessRequest,{operation:'catalog.get_page'}>;
type CatalogResponse = Extract<BusinessResponse,{operation:'catalog.get_page'}>;
type Data = {products:CatalogProduct[];groups:CatalogGroup[]};
type Snapshot = Data & {id:string;revision:string;owner:string;expires:number;cursor:string|null;productIndex:number;groupIndex:number;bytes:number};
const MAX_SNAPSHOTS=4, MAX_SNAPSHOT_BYTES=2*1024*1024, MAX_ROWS=10_000;
function canonical(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if(value!==null && typeof value==='object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function createCatalogPager(read:()=>Data, options:{maxPayloadBytes?:number;ttlMs?:number}={}) {
  const snapshots=new Map<string,Snapshot>();
  const maxPayload=Math.min(16*1024, options.maxPayloadBytes ?? 16*1024);
  const ttl=options.ttlMs ?? 60_000;
  const base=(request:CatalogRequest)=>({type:'response' as const,protocol:2 as const,requestId:request.requestId,sessionId:request.sessionId,operation:'catalog.get_page' as const});
  const unknown=(request:CatalogRequest):CatalogResponse=>({...base(request),outcome:'unknown',errorCode:'unavailable',result:null});
  const expired=(request:CatalogRequest):CatalogResponse=>({...base(request),outcome:'not_applied',errorCode:'snapshot_expired',result:{state:'expired'}});
  const fits=(value:unknown)=>Buffer.byteLength(JSON.stringify(value),'utf8')<=maxPayload;
  function getPage(request:CatalogRequest,context:TrustedContext):CatalogResponse {
    for(const [id,s] of snapshots) if(s.expires<=Date.now()) snapshots.delete(id);
    const {snapshotId,cursor,limit}=request.payload;
    let s:Snapshot;
    if(snapshotId===null) {
      if(cursor!==null || snapshots.size>=MAX_SNAPSHOTS || !Number.isInteger(limit) || limit<1 || limit>25) return unknown(request);
      try {
        const data=read();
        if(!Array.isArray(data.products)||!Array.isArray(data.groups)||data.products.length+data.groups.length>MAX_ROWS) return unknown(request);
        const serialized=JSON.stringify(data);
        const bytes=Buffer.byteLength(serialized,'utf8');
        if(bytes>MAX_SNAPSHOT_BYTES) return unknown(request);
        s={...JSON.parse(serialized) as Data,id:randomBytes(16).toString('hex'),revision:createHash('sha256').update(canonical(data)).digest('hex'),owner:`${context.installationId}:${context.sessionId}`,expires:Date.now()+ttl,cursor:null,productIndex:0,groupIndex:0,bytes};
        // Validate even a single row before storing the snapshot; no partial catalog export.
        for(const product of s.products) if(!validateResponse({...base(request),outcome:'applied',result:{state:'page',snapshotId:s.id,revision:s.revision,nextCursor:null,products:[product],groups:[]}},request,context).ok) return unknown(request);
        for(const group of s.groups) if(!validateResponse({...base(request),outcome:'applied',result:{state:'page',snapshotId:s.id,revision:s.revision,nextCursor:null,products:[],groups:[group]}},request,context).ok) return unknown(request);
        snapshots.set(s.id,s);
      } catch { return unknown(request); }
    } else {
      const found=snapshots.get(snapshotId);
      if(!found || found.owner!==`${context.installationId}:${context.sessionId}` || cursor===null || found.cursor!==cursor) return expired(request);
      s=found;
    }
    let pi=s.productIndex,gi=s.groupIndex;
    const products:CatalogProduct[]=[],groups:CatalogGroup[]=[];
    let nextCursor:string|null=null;
    while(pi<s.products.length || gi<s.groups.length) {
      const isProduct=pi<s.products.length && products.length<limit;
      if(!isProduct && (pi<s.products.length || groups.length>=100)) break;
      const next= isProduct ? s.products[pi] : s.groups[gi];
      if(isProduct) products.push(next as CatalogProduct); else groups.push(next as CatalogGroup);
      const futurePi=pi+(isProduct?1:0), futureGi=gi+(isProduct?0:1);
      const candidate= futurePi<s.products.length || futureGi<s.groups.length ? randomBytes(16).toString('hex') : null;
      const frame={...base(request),outcome:'applied',result:{state:'page',snapshotId:s.id,revision:s.revision,nextCursor:candidate,products,groups}};
      if(!fits(frame) || !validateResponse(frame,request,context).ok) {
        if(isProduct) products.pop(); else groups.pop();
        break;
      }
      pi=futurePi;gi=futureGi;nextCursor=candidate;
      if(products.length===limit && gi===s.groups.length) break;
    }
    if(pi===s.productIndex && gi===s.groupIndex && (pi<s.products.length || gi<s.groups.length)) { snapshots.delete(s.id); return unknown(request); }
    if(pi===s.products.length && gi===s.groups.length) nextCursor=null;
    const response:CatalogResponse={...base(request),outcome:'applied',result:{state:'page',snapshotId:s.id,revision:s.revision,nextCursor,products,groups}};
    if(!fits(response) || !validateResponse(response,request,context).ok) {snapshots.delete(s.id);return unknown(request);}
    s.productIndex=pi;s.groupIndex=gi;s.cursor=nextCursor;
    if(nextCursor===null) snapshots.delete(s.id);
    return response;
  }
  return {getPage,clear:()=>snapshots.clear(),size:()=>snapshots.size};
}
