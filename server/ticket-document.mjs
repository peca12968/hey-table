import {labels,numberOf,tables} from "../lib/menu.mjs";
import {environmentLabel,methods,paymentStates} from "../lib/payments.mjs";
import {datedPickupWindow} from "../lib/pickup-slots.mjs";

const taipeiTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"medium",timeStyle:"medium"});
const amount=value=>"NT$ "+value;

export function orderDetailsText(order,capturedAt){
  const {id,mode,table,status,created,pickupSlot,items,total,paymentMethod,paymentState,paymentEnv,cashReceipt,cashPaymentChange,demoRefund,combo}=order;
  const payment=paymentMethod==="cash"?(cashReceipt?"已登記現金收款":"未登記現金收款"):
    paymentStates[paymentState]??"未記錄";
  const environment=environmentLabel(paymentEnv);
  const dining=mode==="table"?(tables.includes(table)?table+" 桌內用":"內用"):"自取";
  const lines=["禾日食堂｜餐單明細",`取餐號碼 ${numberOf(id)}`,`成立時間（台灣） ${taipeiTime.format(created)}`,
    `擷取時間（台灣） ${taipeiTime.format(capturedAt)}`,`餐單狀態 ${labels[status]??"未記錄"}`,
    `用餐方式 ${dining}`,
    ...(pickupSlot==null?[]:[`預約取餐 ${datedPickupWindow(pickupSlot)}`]),
    `付款方式 ${methods[paymentMethod]??"未記錄"}`,`付款狀態 ${payment}`,
    ...(cashPaymentChange?[`付款變更（台灣） ${taipeiTime.format(cashPaymentChange.changedAt)} 由 ${methods[cashPaymentChange.fromMethod]} 改為現場付款`]:[]),
    ...(environment?[`付款環境 ${environment}`]:[]),"","餐點明細"];
  for(const {id:itemId,name,price,qty} of items){
    const label=String(name??itemId??"餐點").replace(/\s+/gu," ").trim()||"餐點";
    lines.push(`${label} × ${qty} · 單價 ${amount(price)} · 小計 ${amount(price*qty)}`);
  }
  if(combo?.quote)lines.push(`餐點原價 ${amount(combo.quote.subtotal)}`,`套餐折抵 ${amount(combo.quote.discount)}`);
  lines.push(`原餐單金額 ${amount(total)}`);
  if(cashReceipt)lines.push(`現金實收 ${amount(cashReceipt.tendered)} · 找零 ${amount(cashReceipt.change)}`,
    `收款時間（台灣） ${taipeiTime.format(cashReceipt.collectedAt)}`);
  if(demoRefund)lines.push(`示範退款金額 ${amount(demoRefund.amount)}`,
    `退款時間（台灣） ${demoRefund.refundedAt===null?"未記錄":taipeiTime.format(demoRefund.refundedAt)}`);
  return [...lines,""].join("\r\n");
}

export function ticketTextAttachment(text,kind,id){
  return new Response("\uFEFF"+text,{headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"private, no-store",
    "Content-Disposition":`attachment; filename="hey-table-${kind}-${numberOf(id)}.txt"`,"X-Content-Type-Options":"nosniff"}});
}
