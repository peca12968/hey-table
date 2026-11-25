import {useState} from "react";
import {downloadJson} from "../../../lib/download-json.mjs";
import {summarizeIncomingOrders} from "../../../lib/prep-procurement.mjs";
import PurchaseQuote from "./purchase-quote.jsx";

export default function ReadinessPurchase({planner,source,orders,ledger,includePreparing}){
  const [result,setResult]=useState(null);
  const [selected,setSelected]=useState(()=>new Set(ledger?.incomingOrders?.filter(order=>order.lines.length)
    .map(order=>order.purchase_order)));
  const names=new Map(planner.components.map(row=>[row.component,row.name]));
  const selectedOrders=ledger?.incomingOrders?.filter(order=>selected.has(order.purchase_order));
  const summary=selectedOrders?selectedOrders.map(order=>order.purchase_order):ledger?.purchaseOrders;

  function calculate(selection){
    try{
      const incoming=selection?summarizeIncomingOrders(selection):{incoming:ledger?.incoming,sources:new Map()};
      setResult({plan:planner.purchaseInput(orders,includePreparing,incoming.incoming),sources:incoming.sources});
    }catch(error){setResult({error:error.message});}
  }
  function changeSelection(orderId,checked){
    const next=new Set(selected);
    if(checked)next.add(orderId);
    else next.delete(orderId);
    setSelected(next);
    if(result)calculate(ledger.incomingOrders.filter(order=>next.has(order.purchase_order)));
  }
  const plan=result?.plan;
  const shortages=plan?.lines.filter(line=>line.needed>line.available);
  const review=plan?.lines.filter(line=>line.needed>line.available||line.incoming>0);
  function download(){
    const {date,station,scope,capturedAt}=source;
    downloadJson("hey-table-prep-purchase-",capturedAt,{
      format:"hey-table.prep-purchase-input.v1",source:{date,station,scope,capturedAt},
      includePreparing,orderCount:plan.orderCount,lines:plan.lines,
      ...(summary?{purchaseOrders:summary}:{}),
    });
  }
  return <section className="prepReadinessResult prepReadinessFollowup" aria-labelledby="prep-purchase-title">
    <h3 id="prep-purchase-title">採購缺口</h3>
    <p>合併本次試算餐單的用量與半成品批次，依現貨與已確認的在途量推算要補的原料。</p>
    {ledger?.purchaseOrders.length>0&&<p>{summary.length?
      "計入在途採購單 "+summary.join("、"):"本次以現貨計算採購。"}</p>}
    {ledger?.incomingOrders?.length>0&&<fieldset className="prepReadinessFiles prepIncomingOrders">
      <legend>在途採購單明細</legend>
      {ledger.incomingOrders.map(({purchase_order,lines})=><div key={purchase_order}>
        <label className="prepReadinessPreparing"><input type="checkbox" checked={selected.has(purchase_order)}
          disabled={!lines.length} onChange={event=>changeSelection(purchase_order,event.currentTarget.checked)}/>
          計入 {purchase_order}</label>
        {lines.length>0?<details>
          <summary>{purchase_order} 未到貨品項</summary>
          <ul>{lines.map(line=><li key={JSON.stringify([line.supplier,line.sku])}>
            {names.get(line.component)??line.component} · {line.supplier} · {line.sku} · {line.remaining_packs} 包 × {line.pack} {line.unit}
          </li>)}</ul>
        </details>:<p>本單已無待收品項。</p>}
      </div>)}
    </fieldset>}
    <div className="actions">
      <button className="outline" type="button" onClick={()=>calculate(selectedOrders)}>計算採購缺口</button>
      {shortages&&<button className="outline" type="button" onClick={download}>下載 Pantry Freight 採購資料</button>}
    </div>
    {result?.error&&<p className="error" role="alert">{result.error}</p>}
    {shortages&&<>
      <p role="status">試算 {plan.orderCount} 張餐單 · {shortages.length} 項原料需補貨</p>
      {review.length>0&&<ul>{review.map(({component,name,unit,needed,available,on_hand,incoming})=><li key={component}>
        <strong>{name} · {needed>available?"缺 "+(needed-available)+" "+unit:"現貨與在途已涵蓋"}</strong>
        <p>總需求 {needed} {unit} · 盤點庫存 {on_hand??available} {unit}
          {incoming>0&&" · 在途 "+incoming+" "+unit}</p>
        {result.sources.has(component)&&<p>在途來源 {[...result.sources.get(component)]
          .map(([orderId,quantity])=>orderId+" "+quantity+" "+unit).join("、")}</p>}
      </li>)}</ul>}
      {shortages.length>0&&<PurchaseQuote key={JSON.stringify(summary??[])} plan={plan} capturedAt={source.capturedAt}/>}
    </>}
  </section>;
}
