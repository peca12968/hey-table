export const procurementFormat="prep-sheet.procurement.v1";
const invalid=()=>new Error("無法讀取採購快照。請使用 receiving.py procurement 匯出的 JSON。");
const text=value=>typeof value==="string"&&Boolean(value.trim());
const integer=(value,min)=>Number.isSafeInteger(value)&&value>=min;
const byItem=([a,aq],[b,bq])=>a<b?-1:a>b?1:aq-bq;

function quantities(value){
  if(!value||typeof value!=="object"||Array.isArray(value))throw invalid();
  const rows=Object.entries(value);
  if(rows.some(([component,count])=>!text(component)||!integer(count,0)))throw invalid();
  return Object.fromEntries(rows);
}

export function readProcurementSnapshot(value){
  if(value?.format!==procurementFormat||!Array.isArray(value.purchase_orders)||!Array.isArray(value.issued)||
    !value.purchase_orders.every(text)||new Set(value.purchase_orders).size!==value.purchase_orders.length)throw invalid();
  const stock=quantities(value.stock),incoming=quantities(value.incoming),issued=new Map();
  const components=new Set([...Object.keys(stock),...Object.keys(incoming)]);
  if(!value.units||typeof value.units!=="object"||Array.isArray(value.units))throw invalid();
  const units=new Map(Object.entries(value.units));
  if(units.size!==components.size||[...components].some(component=>!text(units.get(component))))throw invalid();
  if(Object.keys(incoming).length>0&&!value.purchase_orders.length)throw invalid();
  for(const row of value.issued){
    const {id,created,items}=row??{};
    if(!integer(id,1)||!integer(created,0)||issued.has(id)||!Array.isArray(items)||!items.length)throw invalid();
    const pairs=items.map(item=>{
      if(!Array.isArray(item)||item.length!==2||!text(item[0])||!integer(item[1],1))throw invalid();
      return [...item];
    }).sort(byItem);
    issued.set(id,{created,items:pairs});
  }
  return {stock,incoming,units,issued,purchaseOrders:[...value.purchase_orders]};
}

export function unissuedPrepOrders(orders,fullOrders,issued,includePreparing){
  const fullById=new Map(fullOrders.map(order=>[order.id,order]));
  const excluded=[];
  const selected=orders.filter(order=>{
    const receipt=issued.get(order.id);
    if(!receipt||order.status!=="pending"&&!includePreparing)return true;
    const full=fullById.get(order.id);
    const items=full?.items?.map(item=>[item.id,item.qty]).sort(byItem);
    if(full?.created!==receipt.created||JSON.stringify(items)!==JSON.stringify(receipt.items))
      throw new Error("餐單 #"+order.id+" 與帳本的領料收據不同。請核對完整餐單。");
    excluded.push(order.id);
    return false;
  });
  return {orders:selected,excluded};
}
