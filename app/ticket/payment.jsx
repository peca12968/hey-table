"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {request} from "../shared";
import {methods,paymentStates,environmentLabel} from "../../lib/payments.mjs";
import {save} from "../../lib/order-storage.mjs";

let sdk;
function loadSdk() {
  if(!sdk)sdk=new Promise((resolve,reject)=>{
    const script=document.createElement("script");
    script.src="https://js.tappaysdk.com/sdk/tpdirect/v5.26.0";
    script.integrity="sha256-TUfo5OAhhvSDiUZgLOC+Qkdg9DPh0WAGx9X9tewAKXs=";
    script.crossOrigin="anonymous";
    script.onload=()=>resolve(window.TPDirect);
    script.onerror=()=>{sdk=undefined;script.remove();reject(Error("付款元件載入失敗，請重新整理"));};
    document.head.append(script);
  });
  return sdk;
}
const providers={line_pay:"linePay",px_pay_plus:"pxPayPlus",jko_pay:"jkoPay",card:"card"};
function getPrime(method) {
  return new Promise((resolve,reject)=>window.TPDirect[providers[method]].getPrime(r=>{
    const prime=method==="card"?r.card?.prime:r.prime;
    if(r.status===0 && prime)resolve(prime);else reject(Error("無法取得付款授權，請確認資料後重試"));
  }));
}
export default function Payment({order,token,onChange}){
  const [attempt,setAttempt]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [ready,setReady]=useState(false),[buyer,setBuyer]=useState({name:"",phone_number:"",email:""});
  const lock=useRef(false),current=useRef(order.paymentState);current.current=order.paymentState;
  const demo=order.paymentEnv==="demo",card=order.paymentMethod==="card";
  const state=attempt?.state??order.paymentState;
  const canStart=["unpaid","failed","cancelled"].includes(state) && order.status==="pending";
  const send=useCallback((path,body={})=>request("/api/payments/"+path,{method:"POST",
    headers:{"Content-Type":"application/json","X-Ticket":token},body:JSON.stringify(body)}),[token]);
  const receive=useCallback(a=>{setAttempt(a);if(a && a.state!==current.current)onChange();},[onChange]);
  useEffect(()=>{
    let live=true;
    const refresh=()=>send("check").then(v=>{if(live && !lock.current)receive(v.attempt);}).catch(e=>{if(live)setError(e.message);});
    refresh();const timer=setInterval(()=>{if(["pending","authorized"].includes(current.current))refresh();},30000);
    return ()=>{live=false;clearInterval(timer);};
  },[send,receive]);
  useEffect(()=>{
    if(demo || !canStart)return;
    let live=true;
    (async()=>{
      const {payments}=await request("/api/menu");
      if(payments.mode!==order.paymentEnv || !payments.methods.includes(order.paymentMethod))throw Error("此付款方式暫停使用");
      const tp=await loadSdk();if(!live)return;
      tp.setupSDK(payments.appId,payments.appKey,payments.mode);
      if(card)tp.card.setup({fields:{
        number:{element:"#pay-number",placeholder:"卡號"},expirationDate:{element:"#pay-expiry",placeholder:"MM / YY"},
        ccv:{element:"#pay-ccv",placeholder:"安全碼"}},styles:{input:{"font-size":"16px"}}});
      setReady(true);
    })().catch(e=>{if(live)setError(e.message);});
    return ()=>{live=false;setReady(false);};
  },[demo,card,canStart,order.paymentEnv,order.paymentMethod]);
  function redirect(a){
    save("he-ri-payment:"+a.ref,token);
    if(["line_pay","jko_pay"].includes(order.paymentMethod) && window.TPDirect?.redirect)window.TPDirect.redirect(a.redirect);
    else window.location.assign(a.redirect);
  }
  async function act(action,outcome){
    if(lock.current)return;
    lock.current=true;setBusy(true);setError("");
    try{
      let body={};
      if(action==="start" && !demo)body={prime:await getPrime(order.paymentMethod),buyer};
      if(action==="demo")body={ref:attempt.ref,outcome};
      const {attempt:a}=await send(action,body);
      receive(a);
      if(action==="start" && a?.redirect)redirect(a);
    }catch(e){setError(e.message);}finally{lock.current=false;setBusy(false);}
  }
  const name=methods[order.paymentMethod];
  return <section className="payBox" aria-label="線上付款"><h2>{name}</h2>
    <p>{environmentLabel(order.paymentEnv)} · <strong role="status">{paymentStates[state]}</strong></p>
    {canStart&&<form onSubmit={e=>{e.preventDefault();act("start");}}>
      {!demo&&<><label>付款人姓名<input required maxLength={40} autoComplete="name" value={buyer.name} onChange={e=>setBuyer({...buyer,name:e.target.value})}/></label>
        <label>手機號碼<input required type="tel" pattern="[+]?[0-9]{8,15}" autoComplete="tel" value={buyer.phone_number} onChange={e=>setBuyer({...buyer,phone_number:e.target.value})}/></label>
        <label>電子郵件<input required type="email" autoComplete="email" maxLength={40} value={buyer.email} onChange={e=>setBuyer({...buyer,email:e.target.value})}/></label>
        {card&&<fieldset><legend>信用卡資料</legend>{[["number","卡號"],["expiry","有效期限"],["ccv","安全碼"]].map(([id,label])=><div key={id}>{label}<div className="payField" id={"pay-"+id}/></div>)}</fieldset>}</>}
      <button className="primary" disabled={busy||(!demo&&!ready)}>{demo?"開始模擬付款":"前往付款"} · NT$ {order.total}</button></form>}
    {state==="pending"&&attempt&&demo&&<div className="actions">{[["paid","模擬付款成功"],["failed","模擬付款失敗"],["cancelled","模擬取消"]].map(([s,label])=><button className="outline" key={s} disabled={busy} onClick={()=>act("demo",s)}>{label}</button>)}</div>}
    {!demo&&attempt?.redirect&&<button className="primary" disabled={busy} onClick={()=>redirect(attempt)}>繼續原付款</button>}
    {!demo&&attempt&&<button className="outline" disabled={busy} onClick={()=>act("check")}>向金流查詢狀態</button>}
    {error&&<p role="alert">{error}</p>}</section>;
}
