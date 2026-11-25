import {useRef,useState} from "react";
import ReadinessOrders from "./readiness-orders.jsx";

const newRow=id=>({id,component:"",quantity:""});

export default function ReadinessArrivals({planner,report,includePreparing}){
  const [rows,setRows]=useState(()=>[newRow(0)]);
  const [result,setResult]=useState(null);
  const nextId=useRef(1);
  const known=new Map(planner.components.map(item=>[item.component,item]));
  const baseline=new Map(report.orders.map(order=>[order.order_id,order.status]));

  function changeRows(value){
    setRows(value);
    setResult(null);
  }
  function changeRow(id,fields){
    changeRows(rows.map(row=>row.id===id?{...row,...fields}:row));
  }
  function calculate(event){
    event.preventDefault();
    try{
      const arrivals=rows.map(({component,quantity})=>({
        component,quantity:/^[0-9]+$/.test(quantity)?Number(quantity):NaN,
      }));
      const {orders}=planner.forecast(report.source.orders,includePreparing,arrivals);
      setResult({orders});
    }catch(error){setResult({error:error.message});}
  }

  const orders=result?.orders??[];
  const ready=orders.filter(order=>order.status==="ready").length;
  const newlyReady=orders.filter(order=>order.status==="ready"&&baseline.get(order.order_id)==="shortage");
  const newlyShort=orders.filter(order=>order.status==="shortage"&&baseline.get(order.order_id)==="ready");
  const affected=orders.filter(order=>order.status==="shortage"||baseline.get(order.order_id)!==order.status);
  return <section className="prepReadinessResult prepReadinessArrivals" aria-labelledby="prep-arrivals-title">
    <h3 id="prep-arrivals-title">預計到貨試算</h3>
    <p>以原盤點庫存和同一批餐單試算，預計到貨只用於本次比較。</p>
    <form onSubmit={calculate}>
      {rows.map((row,index)=><div className="prepArrivalRow" key={row.id}>
        <label>食材 {index+1}<select value={row.component} onChange={event=>changeRow(row.id,{component:event.currentTarget.value})}>
          <option value="">選擇食材</option>
          {planner.components.map(item=><option key={item.component} value={item.component}>
            {item.name} ({item.unit})
          </option>)}
        </select></label>
        <label>數量 {index+1}{row.component?" ("+known.get(row.component).unit+")":""}
          <input inputMode="numeric" value={row.quantity} onChange={event=>changeRow(row.id,{quantity:event.currentTarget.value})}/>
        </label>
        {rows.length>1&&<button type="button" className="outline" onClick={()=>changeRows(rows.filter(item=>item.id!==row.id))}>
          移除第 {index+1} 項
        </button>}
      </div>)}
      <div className="actions">
        <button type="button" className="outline" disabled={rows.length>=planner.components.length}
          onClick={()=>changeRows([...rows,newRow(nextId.current++)])}>新增到貨食材</button>
        <button type="submit" className="primary" disabled={rows.some(row=>!row.component||!row.quantity)}>比較到貨前後</button>
      </div>
    </form>
    {result?.error&&<p className="error" role="alert">{result.error}</p>}
    {result?.orders&&<section aria-label="到貨試算結果">
      <p role="status">可先做 {ready} 張 · 轉為可做 {newlyReady.length} 張 · 轉為缺料 {newlyShort.length} 張</p>
      <ReadinessOrders orders={affected} baseline={baseline}/>
    </section>}
  </section>;
}
