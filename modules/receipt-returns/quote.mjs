import {splitSaving} from "../combo-counter/quote.mjs";

const invalid=()=>new Error("收據計價資料不完整，請核對原單。");
const whole=value=>Number.isSafeInteger(value)&&value>=0;
const compareId=(left,right)=>left===right?0:left<right?-1:1;

function byId(rows){
  if(!Array.isArray(rows))throw invalid();
  const result=new Map();
  for(const row of rows){
    if(typeof row?.id!=="string"||!row.id.trim()||result.has(row.id))throw invalid();
    result.set(row.id,row);
  }
  return result;
}

export function returnLots(ticket){
  const items=byId(ticket?.items);
  if(!items.size||!whole(ticket.total))throw invalid();
  const lots=new Map(),remaining=new Map(),savings=new Map();
  let subtotal=0,discountTotal=0;
  for(const [id,item] of items){
    if(!whole(item.price)||!whole(item.qty)||!item.qty)throw invalid();
    remaining.set(id,item.qty);savings.set(id,0);lots.set(id,[]);
    subtotal+=item.qty*item.price;
    if(!whole(subtotal))throw invalid();
  }
  if(ticket.combo!==undefined){
    const {version,quote}=ticket.combo??{};
    if(version!=="demo-v1"||quote?.currency!=="TWD")throw invalid();
    const savedLines=byId(quote.lines),mains=new Set(),sides=new Set();
    if(savedLines.size!==items.size)throw invalid();
    for(const bundle of byId(quote.bundles).values()){
      const {id,main,side,qty,unitSavings,unitPrice,mainUnitDiscount,sideUnitDiscount}=bundle;
      const primary=items.get(main),secondary=items.get(side);
      if(!primary||!secondary||main===side||sides.has(main)||mains.has(side)||
        !whole(qty)||!qty||!whole(unitSavings)||!unitSavings||!whole(mainUnitDiscount)||!whole(sideUnitDiscount)||
        mainUnitDiscount+sideUnitDiscount!==unitSavings||primary.price+secondary.price===0)throw invalid();
      const [mainDiscount]=splitSaving(primary.price,secondary.price,BigInt(unitSavings));
      if(BigInt(mainUnitDiscount)!==mainDiscount)throw invalid();
      mains.add(main);sides.add(side);
      const mainNet=primary.price-mainUnitDiscount,sideNet=secondary.price-sideUnitDiscount;
      if(mainNet<0||sideNet<0||mainNet+sideNet!==unitPrice)throw invalid();
      for(const [dish,discount,unit] of [[main,mainUnitDiscount,mainNet],[side,sideUnitDiscount,sideNet]]){
        const unpaired=remaining.get(dish)-qty;
        if(unpaired<0)throw invalid();
        remaining.set(dish,unpaired);
        savings.set(dish,savings.get(dish)+qty*discount);
        lots.get(dish).push({bundle:id,qty,unit});
      }
    }
    for(const [id,{qty,price}] of items){
      const saved=savedLines.get(id),discount=savings.get(id),gross=qty*price;
      if(!saved||saved.qty!==qty||saved.price!==price||saved.subtotal!==gross||saved.paired!==qty-remaining.get(id)||
        saved.discount!==discount||saved.total!==gross-discount)throw invalid();
      discountTotal+=discount;
    }
    if(quote.subtotal!==subtotal||quote.discount!==discountTotal||quote.total!==ticket.total)throw invalid();
  }
  if(subtotal-discountTotal!==ticket.total)throw invalid();
  for(const [dish,qty] of remaining){
    const portions=lots.get(dish);
    if(qty)portions.push({bundle:null,qty,unit:items.get(dish).price});
    portions.sort((a,b)=>b.unit-a.unit||compareId(a.bundle??"",b.bundle??""));
  }
  return {lots,total:ticket.total};
}

export function quoteReturn({lots,total},selection){
  if(!(selection instanceof Map)||!selection.size)throw new Error("請至少輸入一項退餐份數。");
  const lines=[];
  let amount=0;
  for(const [dish,quantity] of [...selection].sort(([a],[b])=>compareId(a,b))){
    if(!whole(quantity)||!quantity)throw new Error("退餐份數必須為正整數。");
    let needed=quantity;
    for(const lot of lots.get(dish)??[]){
      const qty=Math.min(needed,lot.qty),part=qty*lot.unit;
      lines.push({dish,...lot,qty,amount:part});
      amount+=part;needed-=qty;
      if(!needed)break;
    }
    if(needed)throw new Error("退餐份數超出原單份數。");
  }
  return {lines,amount,remainingValue:total-amount};
}

export function remainingReturnLots(pricing,entries){
  const lots=new Map([...pricing.lots].map(([dish,portions])=>[dish,portions.map(lot=>({...lot}))]));
  let total=pricing.total;
  for(const entry of entries){
    for(const {dish,bundle,qty,unit,amount} of entry.lines){
      const lot=lots.get(dish)?.find(portion=>portion.bundle===bundle);
      if(!lot||lot.unit!==unit||!whole(qty)||!qty||qty>lot.qty||amount!==qty*unit)throw invalid();
      lot.qty-=qty;
      total-=amount;
    }
  }
  for(const [dish,portions] of lots)lots.set(dish,portions.filter(lot=>lot.qty>0));
  return {lots,total};
}
