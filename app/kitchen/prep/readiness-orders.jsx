import {numberOf} from "../../../lib/menu.mjs";

export default function ReadinessOrders({orders,baseline}){
  if(!orders.length)return null;
  return <ul>{orders.map(order=>{
    const ready=order.status==="ready",changed=baseline&&baseline.get(order.order_id)!==order.status;
    return <li key={order.order_id}>
      <h3>餐單 #{numberOf(order.order_id)} · {ready?"可先做":"缺料暫緩"}{changed&&(ready?" · 轉為可做":" · 轉為缺料")}</h3>
      {order.missing.length>0&&<p>缺 {order.missing.map(line=>line.name+" "+line.quantity+" "+line.unit).join("、")}</p>}
      {order.prep.length>0&&<p>備料順序 {order.prep.map(line=>line.name+" "+line.batches+" 批").join(" → ")}</p>}
    </li>;
  })}</ul>;
}
