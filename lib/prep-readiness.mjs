const invalid=message=>new Error(message);

function entries(value,label){
  if(value===null||typeof value!=="object"||Array.isArray(value))throw invalid(label+"須為 JSON 物件。");
  return Object.entries(value);
}

function amount(value,min,label){
  if(!Number.isSafeInteger(value)||value<min)throw invalid(label+"須為非負安全整數，且符合配方數量。");
  return BigInt(value);
}

function number(value){
  if(value>BigInt(Number.MAX_SAFE_INTEGER))throw invalid("試算結果超過可表示的整數範圍。");
  return Number(value);
}

function quantities(value,known,min,label){
  return entries(value,label).map(([key,raw])=>{
    if(!known.has(key))throw invalid(label+"包含未知食材 "+key+"。");
    return [key,amount(raw,min,label+" "+key)];
  });
}

function readBook(book){
  const root=new Map(entries(book,"食譜"));
  const raw=new Map(entries(root.get("components"),"食材"));
  const graph=new Map(),components=new Map(),dishes=new Map();
  function node(key){
    if(!graph.has(key))graph.set(key,{parents:0,inputs:[]});
    return graph.get(key);
  }
  for(const [key,value] of raw){
    const item=new Map(entries(value,"食材 "+key));
    const unit=item.get("unit"),name=item.get("name")??key;
    if(typeof unit!=="string"||!unit.trim()||typeof name!=="string"||!name.trim())
      throw invalid("食材 "+key+" 缺少名稱或單位。");
    const prepared=item.has("inputs");
    const inputs=prepared?quantities(item.get("inputs"),raw,1,"配方 "+key):[];
    if(prepared&&(item.has("pack")||!inputs.length)||!prepared&&item.has("yield"))
      throw invalid("食材 "+key+" 的配方或包裝設定無效。");
    components.set(key,{name,unit,inputs,size:amount(item.get(prepared?"yield":"pack"),1,"批量 "+key)});
    const current=node(key);
    for(const [input] of inputs){
      current.inputs.push(input);
      node(input).parents++;
    }
  }
  const queue=[...graph].filter(([,entry])=>!entry.parents).map(([key])=>key);
  for(let index=0;index<queue.length;index++){
    for(const key of graph.get(queue[index]).inputs){
      if(--graph.get(key).parents===0)queue.push(key);
    }
  }
  if(queue.length!==components.size)throw invalid("食譜的半成品配方有循環相依。");
  for(const [key,versions] of entries(root.get("dishes"),"餐點")){
    if(!Array.isArray(versions)||!versions.length)throw invalid("餐點 "+key+" 缺少食譜版次。");
    let previous=-1;
    dishes.set(key,versions.map(version=>{
      const fields=new Map(entries(version,"餐點 "+key));
      const from_ms=fields.get("from_ms");
      if(!Number.isSafeInteger(from_ms)||from_ms<=previous)throw invalid("餐點 "+key+" 的版次時間必須遞增。");
      previous=from_ms;
      const uses=quantities(fields.get("uses"),components,1,"餐點 "+key);
      if(!uses.length)throw invalid("餐點 "+key+" 缺少食材。");
      return {from_ms,uses};
    }));
  }
  return {components,dishes,queue};
}

function add(map,key,value){
  map.set(key,(map.get(key)??0n)+value);
}

function activeOrders(orders,includePreparing){
  return orders.filter(order=>order.status==="pending"||includePreparing&&order.status==="preparing");
}

function demandForOrder(order,dishes,demand){
  const portions=new Map();
  for(const {id,qty} of order.items){
    const recipe=dishes.get(id)?.findLast(version=>version.from_ms<=order.created);
    if(!recipe)throw invalid("餐單 #"+order.id+" 的 "+id+" 缺少適用的食譜版次。");
    const quantity=BigInt(qty);
    portions.set(id,{from_ms:recipe.from_ms,quantity:(portions.get(id)?.quantity??0n)+quantity});
    for(const [key,units] of recipe.uses)add(demand,key,units*quantity);
  }
  return portions;
}

function* productionLines(demand,{components,queue},stock){
  for(const component of queue){
    const needed=demand.get(component);
    if(!needed)continue;
    const {name,unit,inputs,size}=components.get(component);
    const available=stock.get(component)??0n,deficit=needed>available?needed-available:0n;
    const batches=(deficit+size-1n)/size;
    if(batches)for(const [input,quantity] of inputs)add(demand,input,quantity*batches);
    yield {component,name,unit,action:inputs.length?"prepare":"purchase",needed,available,deficit,batches,
      remaining:available+batches*size-needed};
  }
}

function forecast(orders,book,available,includePreparing){
  const work=activeOrders(orders,includePreparing).sort((a,b)=>a.created-b.created||a.id-b.id);
  const results=work.map(order=>{
    const demand=new Map(),portions=demandForOrder(order,book.dishes,demand);
    const next=new Map(),missing=[],prep=[];
    for(const {component,name,unit,action,deficit,batches,remaining} of productionLines(demand,book,available)){
      if(action==="purchase"&&deficit){
        missing.push({component,name,unit,quantity:number(deficit)});
        continue;
      }
      next.set(component,remaining);
      if(batches)prep.push({component,name,batches});
    }
    if(!missing.length)for(const [key,value] of next)available.set(key,value);
    return {order_id:order.id,portions:[...portions].sort(([a],[b])=>a<b?-1:a>b?1:0)
      .map(([dish,{from_ms,quantity}])=>({dish,from_ms,quantity:number(quantity)})),
      status:missing.length?"shortage":"ready",missing,
      prep:missing.length?[]:prep.reverse().map(line=>({...line,batches:number(line.batches)}))};
  });
  return {orders:results,remaining_stock:Object.fromEntries([...available].map(([key,value])=>[key,number(value)]))};
}

export function prepReadinessPlanner(bookData,stockData){
  const book=readBook(bookData);
  const stock=new Map(quantities(stockData,book.components,0,"現有庫存"));
  return {
    components:[...book.components].map(([component,{name,unit}])=>({component,name,unit})),
    purchaseInput(orders,includePreparing=false){
      const work=activeOrders(orders,includePreparing),demand=new Map(),lines=[];
      for(const order of work)demandForOrder(order,book.dishes,demand);
      for(const {component,name,unit,action,needed,available} of productionLines(demand,book,stock)){
        if(action==="purchase")lines.push({component,name,unit,action,needed:number(needed),available:number(available)});
      }
      return {orderCount:work.length,lines};
    },
    forecast(orders,includePreparing=false,arrivals=[]){
      const available=new Map(stock),seen=new Set();
      for(const {component,quantity} of arrivals){
        const item=book.components.get(component);
        if(!item)throw invalid("請選擇食譜中的食材。");
        if(seen.has(component))throw invalid("請合併 "+item.name+" 的到貨數量。");
        seen.add(component);
        if(!Number.isSafeInteger(quantity)||quantity<=0)
          throw invalid(item.name+" 的到貨數量須為正整數，且不得超過 "+Number.MAX_SAFE_INTEGER+"。");
        add(available,component,BigInt(quantity));
        if(available.get(component)>BigInt(Number.MAX_SAFE_INTEGER))
          throw invalid(item.name+" 的現有庫存加到貨量超過可表示的範圍。");
      }
      return forecast(orders,book,available,includePreparing);
    },
  };
}

export function forecastPrepReadiness(orders,bookData,stockData,includePreparing=false){
  return prepReadinessPlanner(bookData,stockData).forecast(orders,includePreparing);
}
