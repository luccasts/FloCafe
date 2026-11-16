import type Database from 'better-sqlite3';
import type {CatalogProduct,CatalogGroup} from '../contracts/businessV2';
type OptionRow={id:string;name:string;price:number;is_active:number};
type GroupRow={id:string;name:string;is_active:number;is_required:number;min_selection:number;max_selection:number|null;allow_multiple_quantities:number;addons:OptionRow[]};
type ProductRow={id:string;name:string;price:number;sku:string|null;sale_unit:string;allow_fractional_quantity:number};

function cents(value:unknown):number {
  if(typeof value!=='number' || !Number.isFinite(value) || value<0) throw new Error('catalog_unrepresentable');
  const amount=Math.round(value*100);
  if(!Number.isSafeInteger(amount) || Math.abs(value*100-amount)>1e-6) throw new Error('catalog_unrepresentable');
  return amount;
}
function id(value:unknown):string {
  if(typeof value!=='string' || !value.trim()) throw new Error('catalog_unrepresentable');
  return value;
}
export function readCatalogBridgeSnapshot(db:Database.Database):{products:CatalogProduct[];groups:CatalogGroup[]} {
  const {loadProductRelationsBatch,readActiveProductCatalogRows}=require('../routes/products') as typeof import('../routes/products');
  return db.transaction(()=>{
    const rows:ProductRow[]=readActiveProductCatalogRows(db,10_001);
    if(rows.length>10_000) throw new Error('catalog_unavailable');
    const count=(table:string)=> (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n;
    if(count('product_variants')+count('addons')+count('addon_groups')>10_000) throw new Error('catalog_unavailable');
    // This is the same category/product override and active addon/variant reader used by GET /api/products.
    const relations=loadProductRelationsBatch(db,rows);
    const groups=new Map<string,CatalogGroup>();
    const products=rows.map(row=>{
      const rel=relations.get(row.id);
      const linked=(rel?.addon_groups ?? []) as GroupRow[];
      if(row.sale_unit!=='each' || row.allow_fractional_quantity===1) throw new Error('catalog_unrepresentable');
      for(const group of linked) {
        if(group.allow_multiple_quantities===1) throw new Error('catalog_unrepresentable');
        const mapped:CatalogGroup={id:id(group.id),name:group.name,active:group.is_active===1,required:group.is_required===1,minSelection:group.min_selection,maxSelection:group.max_selection,addons:group.addons.map((addon:OptionRow)=>({id:id(addon.id),name:addon.name,priceCents:cents(addon.price),active:addon.is_active===1}))};
        const previous=groups.get(mapped.id);
        if(previous && JSON.stringify(previous)!==JSON.stringify(mapped)) throw new Error('catalog_group_conflict');
        groups.set(mapped.id,mapped);
      }
      return {id:id(row.id),name:row.name,sku:row.sku,categoryName:rel?.category?.name ?? null,priceCents:cents(row.price),active:true,
        variants:((rel?.variants ?? []) as OptionRow[]).map((variant)=>({id:id(variant.id),name:variant.name,priceCents:cents(variant.price),active:variant.is_active===1})),
        groupIds:linked.map(group=>id(group.id))};
    });
    return {products,groups:[...groups.values()]};
  })();
}
