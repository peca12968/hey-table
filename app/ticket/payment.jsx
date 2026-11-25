"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {request} from "../shared";
import {methods,paymentStates,environmentLabel,paymentCheckMessage} from "../../lib/payments.mjs";
import {save} from "../../lib/order-storage.mjs";
import {paymentPrime,openPaymentUrl} from "../../lib/tappay-client.mjs";
import DemoRefund from "./demo-refund";

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
export default function Payment({order,token,onChange}){
  const [attempt,setAttempt]=useState(null),[busy,setBusy]=useState(""),[error,setError]=useState("");
  const [ready,setReady]=useState(false),[buyer,setBuyer]=useState({name:"",phone_number:"",email:""});
  const lock=useRef(false),actionVersion=useRef(0),current=useRef(order.paymentState);
  const [checkError,setCheckError]=useState("");
  const [recovering,setRecovering]=useState(false),[checkNotice,setCheckNotice]=useState("");
  const [checked,setChecked]=useState(false),[confirmCash,setConfirmCash]=useState(false),[cashConfirmed,setCashConfirmed]=useState(false);
  const demo=order.paymentEnv==="demo",card=order.paymentMethod==="card";
  const working=busy!=="";
  const state=order.paymentState==="refunded"?"refunded":attempt?.state??order.paymentState;
  const canStart=["unpaid","failed","cancelled"].includes(state) && order.status==="pending";
  const canChangeToCash=checked&&!attempt&&state==="unpaid"&&order.status==="pending";
  const send=useCallback((path,body={},signal)=>request("/api/payments/"+path,{method:"POST",
    headers:{"Content-Type":"application/json","X-Ticket":token},body:JSON.stringify(body),signal}),[token]);
  const receive=useCallback(a=>{setAttempt(a);setChecked(true);if(a && a.state!==current.current)onChange();},[onChange]);
  useEffect(()=>{current.current=order.paymentState;},[order.paymentState]);
  useEffect(()=>{
    let live=true,checking=false;
    const controller=new AbortController();
    async function refresh(){
      if(checking || lock.current || document.hidden)return;
      const version=actionVersion.current;
      checking=true;
      try{
        const {attempt:updated}=await send("check",{},AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]));
        if(live && version===actionVersion.current){
          setCheckError("");
          if(updated && ["pending","authorized","paid","partial","refunded"].includes(updated.state))setError("");
          receive(updated);
        }
      }catch(e){
        if(live && version===actionVersion.current)setCheckError(e.message);
      }finally{checking=false;}
    }
    refresh();
    const timer=setInterval(()=>{if(["pending","authorized"].includes(current.current))refresh();},30000);
    document.addEventListener("visibilitychange",refresh);
    window.addEventListener("online",refresh);
    return ()=>{
      live=false;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange",refresh);
      window.removeEventListener("online",refresh);
    };
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
    openPaymentUrl(window.TPDirect,order.paymentMethod,a.redirect,window.location);
  }
  async function checkPayment(afterInterruptedStart){
    const reply=await send("check",{},AbortSignal.timeout(30000));
    receive(reply.attempt);
    setRecovering(false);
    if(afterInterruptedStart&&!reply.attempt){
      setCheckNotice("原餐單目前查無付款紀錄，可重試付款。");
    }else if(afterInterruptedStart&&demo){
      setCheckNotice("已查回原餐單的付款紀錄。");
    }else{
      setCheckNotice(paymentCheckMessage(reply));
    }
  }
  async function act(action,outcome){
    if(lock.current)return;
    lock.current=true;actionVersion.current++;setBusy(action);setError("");setCheckError("");setCheckNotice("");
    let submitted=false;
    try{
      if(action==="check"){
        await checkPayment(recovering);
        return;
      }
      let body={};
      if(action==="start" && !demo)body={prime:await paymentPrime(window.TPDirect,order.paymentMethod),buyer};
      if(action==="demo")body={ref:attempt.ref,outcome};
      submitted=true;
      const timeout=action==="cash"?15000:30000;
      const reply=await send(action,body,AbortSignal.timeout(timeout));
      submitted=false;
      if(action==="cash"){
        setCashConfirmed(true);
        onChange();
        return;
      }
      const a=reply.attempt;
      receive(a);
      if(action==="start" && a?.redirect)redirect(a);
    }catch(e){
      if(action==="start"&&submitted&&(!e.status||e.status>=500&&e.code!=="payment_unavailable")){
        setRecovering(true);
        setBusy("check");
        try{await checkPayment(true);}
        catch{setError("目前無法查回原付款。請使用「向金流查詢狀態」再查一次。");}
        return;
      }
      setError(action==="cash"&&!e.status?"目前無法確認付款變更，可更新收據或再試一次。":
        action==="check"?"無法查詢付款狀態，請稍後再查。":e.message);
      if(e.status===409||action==="cash")onChange();
    }finally{lock.current=false;setBusy("");}
  }
  const name=methods[order.paymentMethod];
  if(cashConfirmed)return <p role="status">已改用現場付款，正在更新收據。</p>;
  return <section className="payBox" aria-label="線上付款"><h2>{name}</h2>
    <p>{environmentLabel(order.paymentEnv)} · <strong role="status">{paymentStates[state]}</strong></p>
    {demo&&state==="refunded"&&<DemoRefund order={order} token={token}/>}
    {canStart&&<form onSubmit={e=>{e.preventDefault();act("start");}}>
      {!demo&&<><label>付款人姓名<input required maxLength={40} autoComplete="name" value={buyer.name} onChange={e=>setBuyer({...buyer,name:e.target.value})}/></label>
        <label>手機號碼<input required type="tel" pattern="[+]?[0-9]{8,15}" autoComplete="tel" value={buyer.phone_number} onChange={e=>setBuyer({...buyer,phone_number:e.target.value})}/></label>
        <label>電子郵件<input required type="email" autoComplete="email" maxLength={40} value={buyer.email} onChange={e=>setBuyer({...buyer,email:e.target.value})}/></label>
        {card&&<fieldset><legend>信用卡資料</legend>{[["number","卡號"],["expiry","有效期限"],["ccv","安全碼"]].map(([id,label])=><div key={id}>{label}<div className="payField" id={"pay-"+id}/></div>)}</fieldset>}</>}
      <button className="primary" disabled={working||recovering||(canChangeToCash&&confirmCash)||(!demo&&!ready)}>{demo?"開始模擬付款":"前往付款"} · NT$ {order.total}</button></form>}
    {canChangeToCash&&!recovering&&(confirmCash?<div className="supplyReview">
      <p>保留原餐單，改到現場支付 NT$ {order.total}。</p>
      <div className="actions">
        <button className="outline" disabled={working} onClick={()=>{setConfirmCash(false);setError("");}}>保留線上付款</button>
        <button className="outline" disabled={working} onClick={()=>act("cash")}>{busy==="cash"?"正在變更…":"確認改用現場付款"}</button>
      </div>
    </div>:<button className="outline" disabled={working} onClick={()=>{setConfirmCash(true);setError("");}}>改用現場付款</button>)}
    {state==="pending"&&attempt&&demo&&<div className="actions">{[["paid","模擬付款成功"],["failed","模擬付款失敗"],["cancelled","模擬取消"]].map(([s,label])=><button className="outline" key={s} disabled={working} onClick={()=>act("demo",s)}>{label}</button>)}</div>}
    {!demo&&state==="pending"&&attempt?.redirect&&<button className="primary" disabled={working} onClick={()=>redirect(attempt)}>繼續原付款</button>}
    {(recovering||!demo&&attempt)&&<button className="outline" disabled={working} onClick={()=>act("check")}>
      {busy==="check"?"正在查詢付款狀態…":"向金流查詢狀態"}</button>}
    {checkNotice&&<p role="status">{checkNotice}</p>}
    {(error||checkError)&&<p role="alert">{error||checkError}</p>}</section>;
}
