const maximum=BigInt(Number.MAX_SAFE_INTEGER);
const smaller=(a,b)=>a<b?a:b;
const larger=(a,b)=>a>b?a:b;
const ceildiv=(value,divisor)=>(value+divisor-1n)/divisor;
const add=(map,key,value)=>map.set(key,(map.get(key)??0n)+value);

function object(value,label){
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(label+"須為 JSON 物件。");
  return value;
}

function rows(value,label){
  if(!Array.isArray(value))throw new Error(label+"須為清單。");
  return value;
}

function text(value,label){
  if(typeof value!=="string"||!value.trim())throw new Error(label+"須為非空白文字。");
  return value;
}

function integer(value,label,min=0){
  if(!Number.isSafeInteger(value)||value<min)throw new Error(label+"超出可用的整數範圍。");
  return BigInt(value);
}

function asNumber(value){
  if(value>maximum)throw new Error("採購結果超出可用的整數範圍，請使用 Pantry Freight 命令列。");
  return Number(value);
}

function textual(a,b){
  const left=[...a],right=[...b];
  for(let index=0;index<Math.min(left.length,right.length);index++){
    const difference=left[index].codePointAt(0)-right[index].codePointAt(0);
    if(difference)return difference;
  }
  return left.length-right.length;
}

function input(plan,catalog){
  const needs=new Map(),units=new Map(),components=new Set();
  for(const value of rows(plan?.lines,"備料原料")){
    const row=object(value,"原料"),key=text(row.component,"原料代碼");
    if(components.has(key)||!["prepare","purchase"].includes(row.action))throw new Error("原料 "+key+" 的項目重複或格式有誤。");
    components.add(key);
    if(row.action!=="purchase")continue;
    units.set(key,text(row.unit,"原料單位"));
    const gap=integer(row.needed,"原料需求")-integer(row.available,"原料庫存");
    if(gap>0n)needs.set(key,gap);
  }
  if(catalog?.currency!=="TWD")throw new Error("供應商目錄須使用新台幣 TWD。");
  const suppliers=new Map(),offers=[],skus=new Set();
  for(const value of rows(catalog.suppliers,"供應商")){
    const row=object(value,"供應商"),id=text(row.id,"供應商代碼");
    if(suppliers.has(id))throw new Error("供應商代碼重複 "+id+"。");
    suppliers.set(id,{fee:integer(row.shipping,"運費"),threshold:row.free_at==null?null:integer(row.free_at,"免運門檻")});
  }
  for(const value of rows(catalog.offers,"供應品項")){
    const row=object(value,"供應品項"),sku=text(row.sku,"SKU");
    const supplier=text(row.supplier,"供應商代碼"),component=text(row.component,"原料代碼");
    if(skus.has(sku)||!suppliers.has(supplier))throw new Error(sku+" 的 SKU 重複或供應商不存在。");
    skus.add(sku);
    const unit=text(row.unit,"供應單位");
    if(units.has(component)&&units.get(component)!==unit)throw new Error(sku+" 的供應單位與備料資料不同。");
    const offer={sku,supplier,component,pack:integer(row.pack,"每包含量",1),
      price:integer(row.price,"每包價格",1),stock:integer(row.stock,"可供包數")};
    if(needs.has(component)&&offer.stock)offers.push(offer);
  }
  const limits=new Map(Object.entries(object(catalog.max_surplus===undefined?{}:catalog.max_surplus,"原料剩餘上限"))
    .map(([key,value])=>[key,integer(value,"原料 "+key+" 的剩餘上限")]));
  return {needs:new Map([...needs].sort(([a],[b])=>textual(a,b))),units,suppliers,
    offers:offers.sort((a,b)=>textual(a.sku,b.sku)),limits};
}

function freight({fee,threshold},spent){
  return spent&&(threshold===null||spent<threshold)?fee:0n;
}

function better(left,right){
  if(!right)return true;
  if(left.cost!==right.cost)return left.cost<right.cost;
  if(left.packs!==right.packs)return left.packs<right.packs;
  for(let index=0;index<left.counts.length;index++){
    if(left.counts[index]!==right.counts[index])return left.counts[index]<right.counts[index];
  }
  return false;
}

function optimize(needs,suppliers,offers,limits){
  const vendors=[...new Set(offers.map(offer=>offer.supplier))].sort(textual);
  const vendorIndex=new Map(vendors.map((id,index)=>[id,index]));
  const byItem=new Map([...needs.keys()].map(component=>[component,[]]));
  offers.forEach((offer,index)=>byItem.get(offer.component).push([offer,index]));
  const credit=vendors.map(()=>0n);
  let frontier=new Map([[credit.join(","),{credit,cost:0n,packs:0n,counts:offers.map(()=>0n)}]]);
  const stateWeight=offers.length+vendors.length+6;
  const tooLarge=() => new Error("供應商組合超出瀏覽器試算上限，請下載採購資料給 Pantry Freight 命令列試算。");
  let work=0;
  for(const [component,gap] of needs){
    const capOnUnits=limits.has(component)?gap+limits.get(component):null;
    let states=new Map([...frontier].map(([key,value])=>[key+";0",{...value,covered:0n}]));
    for(const [offer,index] of byItem.get(component)){
      const position=vendorIndex.get(offer.supplier),{fee,threshold}=suppliers.get(offer.supplier);
      const cap=fee?(threshold??1n):0n;
      let left=smaller(offer.stock,larger(ceildiv(gap,offer.pack),ceildiv(cap,offer.price)));
      for(let block=1n;left;block*=2n){
        const count=smaller(block,left),spend=count*offer.price;
        left-=count;
        work+=states.size*stateWeight;
        if(work>20_000_000)throw tooLarge();
        const next=new Map(states);
        for(const previous of states.values()){
          const units=previous.covered+count*offer.pack;
          if(capOnUnits!==null&&units>capOnUnits)continue;
          const credit=[...previous.credit],counts=[...previous.counts];
          credit[position]=smaller(cap,credit[position]+spend);
          counts[index]+=count;
          const covered=capOnUnits===null?smaller(gap,units):units;
          const plan={credit,covered,counts,cost:previous.cost+spend,packs:previous.packs+count};
          const key=credit.join(",")+";"+covered;
          if(better(plan,next.get(key)))next.set(key,plan);
        }
        if(next.size*stateWeight>2_000_000)throw tooLarge();
        states=next;
      }
    }
    frontier=new Map();
    for(const plan of states.values()){
      if(plan.covered<gap)continue;
      const key=plan.credit.join(",");
      if(better(plan,frontier.get(key)))frontier.set(key,plan);
    }
    if(!frontier.size)return {blocked:component};
  }
  let best;
  for(const plan of frontier.values()){
    const fee=vendors.reduce((sum,id,index)=>sum+freight(suppliers.get(id),plan.credit[index]),0n);
    const final={...plan,cost:plan.cost+fee};
    if(better(final,best))best=final;
  }
  return {counts:best.counts,packs:best.packs};
}

export function quotePantryPurchase(plan,catalog){
  const {needs,units,suppliers,offers,limits}=input(plan,catalog);
  const capacity=new Map();
  for(const offer of offers)add(capacity,offer.component,offer.pack*offer.stock);
  const shortages=[];
  for(const [component,required] of needs){
    const offered=capacity.get(component)??0n;
    if(offered<required)shortages.push({component,unit:units.get(component),required:asNumber(required),
      offered:asNumber(offered),uncovered:asNumber(required-offered)});
  }
  if(shortages.length)return {status:"infeasible",shortages};
  const {blocked,counts,packs}=optimize(needs,suppliers,offers,limits);
  if(blocked!==undefined)return {status:"infeasible",pack_limit:{component:blocked,unit:units.get(blocked),
    required:asNumber(needs.get(blocked)),max_purchase:asNumber(needs.get(blocked)+limits.get(blocked))}};
  const loads=new Map(),received=new Map();
  offers.forEach(({supplier,sku,component,pack,price},index)=>{
    const count=counts[index];
    if(!count)return;
    const row={sku,component,packs:asNumber(count),pack:asNumber(pack),unit:units.get(component),
      unit_price_twd:asNumber(price),cost_twd:asNumber(count*price)};
    if(!loads.has(supplier))loads.set(supplier,[]);
    loads.get(supplier).push(row);
    add(received,component,pack*count);
  });
  let total=0n,shipping=0n;
  const orders=[...loads].sort(([a],[b])=>textual(a,b)).map(([supplier,lines])=>{
    const subtotal=lines.reduce((sum,line)=>sum+BigInt(line.cost_twd),0n);
    const fee=freight(suppliers.get(supplier),subtotal);
    total+=subtotal+fee;
    shipping+=fee;
    return {supplier,lines,subtotal_twd:asNumber(subtotal),shipping_twd:asNumber(fee),total_twd:asNumber(subtotal+fee)};
  });
  return {status:"ok",currency:"TWD",orders,total_twd:asNumber(total),shipping_twd:asNumber(shipping),packs:asNumber(packs),
    ingredients:[...received].sort(([a],[b])=>textual(a,b)).map(([component,quantity])=>({
      component,shortfall:asNumber(needs.get(component)),purchased:asNumber(quantity),
      surplus:asNumber(quantity-needs.get(component)),unit:units.get(component),
    })),quantities:Object.fromEntries([...received].map(([component,quantity])=>[component,asNumber(quantity)]))};
}
