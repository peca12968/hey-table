const draftFormat="prep-sheet.receiving-draft.v1";
const invalid=()=>new Error("無法讀取採購單狀態。請選擇 receiving.py status 匯出的 JSON。");
const text=value=>typeof value==="string"&&Boolean(value.trim());
const isCount=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;

export const receivingStateLabels={open:"待驗收",partial:"部分處理",received:"已全數驗收",closed:"已結案",cancelled:"已取消"};

export function readReceivingStatus(value){
  if(!text(value?.purchase_order)||!Object.hasOwn(receivingStateLabels,value.state)||
    !isCount(value.remaining_packs)||!Array.isArray(value.lines)||!value.lines.length)throw invalid();
  const seen=new Set();
  const lines=value.lines.map(row=>{
    const {supplier,sku,component,unit,pack,ordered_packs,received_packs,cancelled_packs,remaining_packs}=row??{};
    const identity=JSON.stringify([supplier,sku]);
    if(![supplier,sku,component,unit].every(text)||seen.has(identity)||!isCount(pack,1)||!isCount(ordered_packs,1)||
      ![received_packs,cancelled_packs,remaining_packs].every(count=>isCount(count))||
      ordered_packs-received_packs-cancelled_packs!==remaining_packs)throw invalid();
    seen.add(identity);
    return {supplier,sku,component,unit,pack,ordered_packs,received_packs,cancelled_packs,remaining_packs};
  });
  const remaining=lines.reduce((total,line)=>total+line.remaining_packs,0);
  const received=lines.some(line=>line.received_packs>0),cancelled=lines.some(line=>line.cancelled_packs>0);
  const state=remaining?(received||cancelled?"partial":"open"):(cancelled?(received?"closed":"cancelled"):"received");
  if(remaining!==value.remaining_packs||state!==value.state)throw invalid();
  return {purchase_order:value.purchase_order,state,remaining_packs:remaining,lines};
}

export function receivingDraft(status,supplier,deliveryId,entries){
  const delivery_id=deliveryId.trim();
  if(!delivery_id)throw new Error("請填寫送貨單號。");
  const rows=new Map(status.lines.filter(line=>line.supplier===supplier).map(line=>[line.sku,line]));
  const lines=[];
  for(const [sku,input] of entries){
    const row=rows.get(sku);
    if(!row)throw new Error("採購單沒有這個供應商的 SKU。");
    const count=input===""?0:/^[0-9]+$/.test(input)?Number(input):NaN;
    if(!isCount(count)||count>row.remaining_packs)
      throw new Error(sku+" 的實收包數須為整數，最多 "+row.remaining_packs+" 包。");
    if(count){
      const {component,unit,pack,ordered_packs,received_packs,cancelled_packs,remaining_packs}=row;
      lines.push({sku,component,unit,pack,ordered_packs,received_packs,cancelled_packs,remaining_packs,packs:count});
    }
  }
  if(!lines.length)throw new Error("請填寫至少一項實收包數。");
  return {format:draftFormat,purchase_order:status.purchase_order,supplier,delivery_id,lines};
}
