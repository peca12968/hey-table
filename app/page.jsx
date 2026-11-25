"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {Plus,Minus,ShoppingBag,X,Utensils,Check} from "lucide-react";
import {dishes,itemNoteLimit,tables,withItemNotes} from "../lib/menu.mjs";
import {Header,Footer,Mode,request} from "./shared";
import {cartKey,claimCart,dispatchCart,openReceipt,persistCart,read,settleCart} from "../lib/order-storage.mjs";
import {comboVersion,priceCombos} from "../lib/combo-pricing.mjs";
import {intakeNotice} from "../lib/order-intake.mjs";
import CartAddOn from "./cart-add-on";
import CartQuote from "./cart-quote";
import Reorder from "./reorder";
import {ItemNotesEditor} from "./item-notes";
import PickupSlots,{PickupDate,usePickupSlotAvailability} from "./pickup-slots";
import PickupSuggestion from "./pickup-suggestion";
import {useBusinessToday} from "./use-business-today.mjs";
import {pickupBookingDays,pickupSlotDuration} from "../lib/pickup-slots.mjs";

import {methods,environmentLabel} from "../lib/payments.mjs";
const groups=["全部","丼飯","小食","飲品"];
const lookupMessages={
  checking:"正在確認這張餐單是否已送達…",
  missing:"目前查無這張訂單。請重試同一張訂單以送達廚房。",
  timeout:"查詢送單結果逾時。請重新查詢，或重試同一張訂單。",
  unavailable:"目前無法確認送單結果。恢復連線後會再查，也可重試同一張訂單。",
};
async function checkoutRequest(url,options,timeout){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new DOMException("點餐請求逾時","TimeoutError")),timeout);
  const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
  try{return await request(url,{...options,signal});}
  catch(error){
    if(controller.signal.aborted&&!options.signal?.aborted)throw controller.signal.reason;
    throw error;
  }
  finally{clearTimeout(timer);}
}

export default function Menu(){
  const [table,setTable]=useState(null),[scope,setScope]=useState(""),[group,setGroup]=useState("全部");
  const [selection,setSelection]=useState({cart:{},lineNotes:{}});
  const {cart,lineNotes}=selection;
  const [note,setNote]=useState(""),[sold,setSold]=useState([]),[availability,setAvailability]=useState(null);
  const [remaining,setRemaining]=useState({});
  const [supplyReview,setSupplyReview]=useState(null);
  const [draft,setDraft]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[panel,setPanel]=useState(false);
  const [announcement,setAnnouncement]=useState(""); const sending=useRef(false);
  const [method,setMethod]=useState("cash"),[payments,setPayments]=useState({methods:["cash"]});
  const [intake,setIntake]=useState({});
  const [tableIntake,setTableIntake]=useState({});
  const activeMenuRequest=useRef(null);
  const [useCombo,setUseCombo]=useState(false);
  const [lookup,setLookup]=useState(null),[lookupRevision,setLookupRevision]=useState(0);
  const [sendTimedOut,setSendTimedOut]=useState(false);
  const [sharedCheckout,setSharedCheckout]=useState(false);
  const checkoutSeen=useRef(null);
  const [repeat,setRepeat]=useState("");
  const [pickupSlot,setPickupSlot]=useState(null),[slotRevision,setSlotRevision]=useState(0);
  const [pickupDate,setPickupDate]=useState("");
  const [pickupPaused,setPickupPaused]=useState(false);
  const today=useBusinessToday();
  const bookingDay=pickupDate===today?"":pickupDate;
  const supplyDay=bookingDay||today;
  const loaded=availability?.date===supplyDay&&availability.status==="ready";
  const menuFailed=availability?.date===supplyDay&&availability.status==="failed";
  const refreshMenu=useCallback(async(replace=false)=>{
    if(!supplyDay||(!replace&&activeMenuRequest.current))return;
    activeMenuRequest.current?.abort();
    const controller=new AbortController();
    activeMenuRequest.current=controller;
    if(replace)setAvailability(current=>current?.date===supplyDay&&current.status==="failed"?
      {date:supplyDay,status:"loading"}:current);
    try{
      const data=await request("/api/menu"+(bookingDay?"?date="+bookingDay:""),{
        signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),
      });
      if(controller.signal.aborted)return;
      setSold(data.unavailable);
      setRemaining(data.remaining??{});
      setPayments(data.payments??{methods:["cash"]});
      setIntake(data.accepting??{});
      setTableIntake(data.acceptingTables??{});
      setPickupPaused(data.pickupPaused===true);
      setAvailability({date:supplyDay,status:"ready"});
    }catch{
      if(!controller.signal.aborted)setAvailability({date:supplyDay,status:"failed"});
    }finally{
      if(activeMenuRequest.current===controller)activeMenuRequest.current=null;
    }
  },[bookingDay,supplyDay]);
  const loadCart=useCallback((old,param)=>{
    const cart=Object.fromEntries(dishes.filter(d=>Number.isInteger(old.cart?.[d.id])&&old.cart[d.id]>0&&old.cart[d.id]<=20).map(d=>[d.id,old.cart[d.id]]));
    const lineNotes=Object.fromEntries(Object.keys(cart).filter(id=>typeof old.lineNotes?.[id]==="string")
      .map(id=>[id,old.lineNotes[id].slice(0,itemNoteLimit)]));
    checkoutSeen.current=old.checkout??null;
    setSelection({cart,lineNotes});setUseCombo(old.useCombo===true);
    setNote(old.note??"");setDraft(old.draft??null);setMethod(old.draft?.paymentMethod??old.method??'cash');
    const savedSlot=old.draft?old.draft.pickupSlot:old.pickupSlot;
    const days=pickupBookingDays(Date.now());
    const validDay=!old.pickupDate||days.includes(old.pickupDate);
    const validSlot=!param&&(validDay||old.draft)&&Number.isSafeInteger(savedSlot)&&savedSlot>0&&savedSlot<=8_640_000_000_000_000-pickupSlotDuration;
    setPickupSlot(validSlot?savedSlot:null);
    setPickupDate(!param&&validDay?old.pickupDate??"":"");
  },[]);
  useEffect(()=>{
    const param=new URLSearchParams(location.search).get("table"),key=cartKey(param),old=read(key,{});
    setTable(param);setScope(key);loadCart(old,param);
    const token=new URLSearchParams(location.hash.slice(1)).get("reorder")??"";
    setRepeat(token);
    if((old.draft||token)&&window.matchMedia("(max-width: 680px)").matches) setPanel(true);
  },[loadCart]);
  useEffect(()=>{
    refreshMenu();
    const online=()=>refreshMenu(true);
    const returnToMenu=()=>{if(document.visibilityState==="visible")online();};
    const timer=setInterval(()=>{if(document.visibilityState==="visible")refreshMenu();},15000);
    window.addEventListener("online",online);
    document.addEventListener("visibilitychange",returnToMenu);
    return ()=>{
      activeMenuRequest.current?.abort();
      activeMenuRequest.current=null;
      clearInterval(timer);
      window.removeEventListener("online",online);
      document.removeEventListener("visibilitychange",returnToMenu);
    };
  },[refreshMenu]);
  useEffect(()=>{
    if(scope)persistCart(scope,{cart,lineNotes,note,draft,method,useCombo,pickupSlot,pickupDate},checkoutSeen.current);
  },[scope,cart,lineNotes,note,draft,method,useCombo,pickupSlot,pickupDate]);
  useEffect(()=>{
    if(!draft||busy||!scope)return;
    let current;
    async function findReceipt(){
      if(current||sending.current)return;
      const controller=new AbortController();
      current=controller;
      setLookup({token:draft.token,status:"checking"});
      try{
        const order=await checkoutRequest("/api/ticket",{headers:{"X-Ticket":draft.token},signal:controller.signal},10000);
        if(!controller.signal.aborted && !sending.current)await openReceipt(scope,draft.token,order);
      }catch(e){
        if(controller.signal.aborted || sending.current)return;
        setLookup({token:draft.token,status:e.status===404?"missing":e.name==="TimeoutError"?"timeout":"unavailable"});
      }finally{current=null;}
    }
    const recheckOnReturn=()=>{if(document.visibilityState==="visible")findReceipt();};
    findReceipt();
    window.addEventListener("online",findReceipt);
    document.addEventListener("visibilitychange",recheckOnReturn);
    return ()=>{
      current?.abort();
      window.removeEventListener("online",findReceipt);
      document.removeEventListener("visibilitychange",recheckOnReturn);
    };
  },[scope,draft,busy,lookupRevision]);
  useEffect(()=>{if(!panel)return;const close=e=>{if(e.key==="Escape")setPanel(false);};window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close);},[panel]);
  const invalid=table!==null&&!tables.includes(table), lines=dishes.filter(d=>cart[d.id]>0);
  const mode=table?"table":"pickup";
  const pausedTable=table&&tableIntake[table]===false ? table : null;
  const paused=!!scope&&(intake[mode]===false || pausedTable!==null);
  const count=lines.reduce((s,d)=>s+cart[d.id],0), subtotal=lines.reduce((s,d)=>s+d.price*cart[d.id],0);
  const items=lines.map(d=>({id:d.id,qty:cart[d.id]}));
  const offer=count && (payments.mode==="demo" || draft?.comboVersion===comboVersion)
    ? priceCombos(items) : null;
  const applied=draft ? draft.comboVersion===comboVersion : useCombo && offer?.discount>0;
  const total=applied ? draft?.expectedTotal??offer.total : subtotal;
  const maxFor=id=>Math.min(20,remaining[id]??20);
  const limitBlocked=lines.some(({id})=>cart[id]>(remaining[id]??20));
  const needsPickupSlot=!!bookingDay&&pickupSlot===null;
  const pickupAvailability=usePickupSlotAvailability({selected:pickupSlot,count,day:bookingDay,revision:slotRevision,
    active:count>0&&!!scope&&mode==="pickup"&&!draft});
  const dayPaused=pickupAvailability.snapshot?.paused??pickupPaused;
  const bookingPaused=dayPaused&&(!!bookingDay||pickupSlot!==null);
  const pickupBlocked=needsPickupSlot||bookingPaused||pickupAvailability.selectedBlocked;
  const blocked=limitBlocked||lines.some(({id})=>sold.includes(id));
  const suggestPickup=loaded&&!invalid&&!draft&&!busy&&!paused&&(blocked||dayPaused||
    (pickupAvailability.snapshot&&(pickupAvailability.selectedBlocked||!pickupAvailability.slots.some(slot=>slot.remaining>=count))));
  const cannotAdd=id=>sold.includes(id)||(cart[id]||0)>=maxFor(id);
  const adjustments=blocked?lines.flatMap(({id,name})=>{
    const from=cart[id],to=sold.includes(id)?0:maxFor(id);
    return from>to?[{id,name,from,to}]:[];
  }):[];
  const adjustmentKey=JSON.stringify([supplyDay,adjustments]);
  function change(id,delta){
    if(draft||busy||(delta>0&&cannotAdd(id)))return;
    setSelection(current=>{
      const qty=current.cart[id]||0;
      if(delta>0&&qty>=maxFor(id))return current;
      const next=Math.max(0,qty+delta);
      const lineNotes={...current.lineNotes};
      if(!next)delete lineNotes[id];
      return {cart:{...current.cart,[id]:next},lineNotes};
    });
    setError("");setSupplyReview(null);setAnnouncement((dishes.find(d=>d.id===id)?.name??"")+"數量已更新");
  }
  function dismissRepeat(){
    setRepeat("");
    history.replaceState(history.state,"",location.pathname+location.search);
  }
  function addRepeat(plan){
    if(draft||busy||sending.current||read(scope,{}).draft)return false;
    setSelection(current=>{
      const next={...current.cart};
      for(const {id,added} of plan){
        const current=next[id]||0;
        if(added&&!sold.includes(id)&&current<maxFor(id))next[id]=Math.min(maxFor(id),current+added);
      }
      return {...current,cart:next};
    });
    dismissRepeat();
    setSupplyReview(null);
    setAnnouncement("先前餐點已加入餐單，請確認後送出。");
    return true;
  }
  function selectPickupDate(day,start=null){
    setPickupDate(day);setPickupSlot(start);setError("");setSupplyReview(null);
    if((day||today)!==supplyDay){
      setRemaining({});setPickupPaused(false);setAvailability(null);
    }
  }
  function applySupplyReview(){
    if(!loaded||draft||busy||sending.current||!adjustments.length||supplyReview?.key!==adjustmentKey)return;
    setSelection(current=>{
      if(adjustments.some(({id,from})=>current.cart[id]!==from))return current;
      const nextCart={...current.cart},nextNotes={...current.lineNotes};
      for(const {id,to} of adjustments){
        nextCart[id]=to;
        if(to===0)delete nextNotes[id];
      }
      return {cart:nextCart,lineNotes:nextNotes};
    });
    setError("");setSupplyReview(null);
    setAnnouncement("已依供應調整餐單，請確認新的份數和金額。");
  }
  async function submit(){
    if(sending.current||invalid||!scope||!count||(!draft&&(paused||blocked||pickupBlocked||!loaded)))return;
    sending.current=true;setBusy(true);setError("");setLookup(null);setSendTimedOut(false);setSharedCheckout(false);
    const payload=draft??{token:crypto.randomUUID(),...(method==='cash'?{}:{paymentMethod:method}),mode,table,note,
      items:withItemNotes(items,lineNotes),...(applied?{comboVersion,expectedTotal:total}:{}),...(pickupSlot!==null?{pickupSlot}:{})};
    const snapshot={cart,lineNotes,note,draft:payload,method,useCombo,pickupSlot,pickupDate};
    let leaving=false;
    async function dispatch(){
      const claimed=await claimCart(scope,snapshot,checkoutSeen.current);
      if(!claimed.send){
        const {record}=claimed;
        if(!record.draft&&record.checkout?.state==="completed"){
          location.replace("/ticket#"+record.checkout.token);
          leaving=true;
        }else{
          loadCart(record,table);
          if(record.draft)setSharedCheckout(true);
          else setError("另一個分頁已更新這張餐單，請核對後再送出。");
        }
        return;
      }
      setDraft(payload);
      try{
        const order=await checkoutRequest("/api/orders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)},15000);
        await openReceipt(scope,payload.token,order);
        leaving=true;
      }catch(e){
        if(e.name==="TimeoutError")setSendTimedOut(true);
        if([400,409,415].includes(e.status)){
          const stored=await settleCart(scope,payload.token,"rejected");
          if(stored.checkout?.token===payload.token&&stored.checkout.state==="completed"){
            location.replace("/ticket#"+payload.token);
            leaving=true;
            return;
          }
          if(stored.draft)loadCart(stored,table);
          else{
            checkoutSeen.current=stored.checkout??checkoutSeen.current;
            setDraft(null);
          }
          if(e.code==="intake_paused")setIntake(current=>({...current,[mode]:false}));
          else if(e.code==="table_paused")setTableIntake(current=>({...current,[table]:false}));
          else setError(e.message);
          if(["pickup_slot_closed","pickup_slot_full","pickup_day_paused"].includes(e.code))setSlotRevision(value=>value+1);
          refreshMenu(true);
        }
      }
    }
    try{
      await dispatchCart(scope,dispatch);
    }catch{
      setError("暫時無法確認其他分頁的送單狀態，請稍後重試。");
    }finally{
      if(!leaving){sending.current=false;setBusy(false);}
    }
  }
  const hero=dishes[0],unavailableForAddOn=dishes.filter(d=>cannotAdd(d.id)).map(d=>d.id);
  const quoteBody=JSON.stringify({items});
  const addOnBody=bookingDay?JSON.stringify({items,pickupDate:bookingDay}):quoteBody;
  const supplyLabel=bookingDay?"取餐日":"今日";
  const lookupStatus=draft&&lookup?.token===draft.token?lookup.status:"checking";
  function addButton(d){return <button className="add" aria-label={"加入"+d.name} disabled={!loaded||busy||!!draft||cannotAdd(d.id)||invalid} onClick={()=>change(d.id,1)}><Plus size={18}/></button>;}
  return <><Header home/><main className="shell">
    <section className="hero"><div className="heroCopy"><p className="kicker"><span/> 本日主廚推薦</p><h1>{hero.name}</h1><p>{hero.description}</p><button className="heroAction" onClick={()=>change(hero.id,1)} disabled={!loaded||busy||!!draft||cannotAdd(hero.id)||invalid}><Plus size={16}/> 加入餐單 <b>NT$ {hero.price}</b></button></div><img className="heroImg" src="/food/katsudon.webp" alt="滑蛋豬排丼"/></section>
    {invalid&&<p className="error" role="alert">桌號無效，請重新掃描桌牌。也可<a href="/">改為線上自取</a>。</p>}
    {paused&&!invalid&&<p className="error" role="status">{intakeNotice(mode,intake[mode]===false?null:pausedTable)}</p>}
    <div className="columns"><section><div className="menuTitle"><div><p className="eyebrow">OUR MENU</p><h2>點餐菜單</h2></div><Mode table={table}/></div>
    {scope&&mode==="pickup"&&<PickupDate value={pickupDate} disabled={busy||!!draft} paused={dayPaused} onChange={selectPickupDate}/>}
    <nav className="tabs" aria-label="餐點分類">{groups.map(g=><button key={g} aria-pressed={group===g} onClick={()=>setGroup(g)}>{g}</button>)}</nav>
    <div className="grid">{dishes.filter(d=>group==="全部"||d.group===group).map(d=><article className="dish" key={d.id}><img src={"/food/"+d.id+".webp"} alt={d.name} loading="lazy"/><div className="dishInfo"><small>{d.group}</small><h3>{d.name}</h3><p>{d.description}</p>
      {!sold.includes(d.id)&&remaining[d.id]>0&&<p className="muted">{supplyLabel}剩餘 {remaining[d.id]} 份</p>}
      <div className="price"><strong>NT$ {d.price}</strong>{sold.includes(d.id)||remaining[d.id]===0?<span>已售完</span>:addButton(d)}</div></div></article>)}</div></section>
    {panel&&<button className="shade" aria-label="關閉餐單" onClick={()=>setPanel(false)}/>}
    <aside className={"cart "+(panel?"opened":"")} aria-label="我的餐單"><div className="cartHead"><h2><ShoppingBag size={21}/> 我的餐單</h2><span>{count} 件</span><button className="mobileClose" aria-label="關閉" onClick={()=>setPanel(false)}><X size={19}/></button></div>
    <div className="cartMode"><Mode table={table}/><span>{methods[method]}</span></div>
    {repeat&&scope&&!invalid&&<Reorder token={repeat} table={table} sold={sold} remaining={remaining} loaded={loaded} cart={cart}
      blocked={!!draft||busy} onAdd={addRepeat} onClose={dismissRepeat}/>}
    {!count?<div className="empty"><Utensils size={30}/><strong>餐單還是空的</strong><p>從菜單加入想吃的餐點</p></div>:<ul className="orderLines">{lines.map(d=><li key={d.id}><div><b>{d.name}{sold.includes(d.id)||remaining[d.id]===0?"（售完）":""}</b><small>NT$ {d.price*cart[d.id]}</small></div><div className="stepper"><button disabled={!!draft||busy} aria-label={"減少"+d.name} onClick={()=>change(d.id,-1)}><Minus size={14}/></button><span>{cart[d.id]}</span><button disabled={!!draft||busy||cannotAdd(d.id)} aria-label={"增加"+d.name} onClick={()=>change(d.id,1)}><Plus size={14}/></button></div></li>)}</ul>}
    {loaded&&!invalid&&!blocked&&!draft&&!busy&&lines.some(d=>d.group==="丼飯")&&
      <CartAddOn key={addOnBody+JSON.stringify(unavailableForAddOn)} body={addOnBody} sold={unavailableForAddOn} onAdd={id=>change(id,1)}/>}
    {count>0&&<ItemNotesEditor dishes={lines} notes={lineNotes} disabled={!!draft||busy} onChange={(id,value)=>
      setSelection(current=>({...current,lineNotes:{...current.lineNotes,[id]:value}}))}/>}
    {count>0&&<label className="note">訂單備註 <small>選填</small><textarea placeholder="例如：餐具數量" value={note} maxLength={160} disabled={!!draft||busy} onChange={e=>setNote(e.target.value)}/></label>}
    {count>0&&scope&&mode==="pickup"&&<PickupSlots selected={pickupSlot} count={count} day={bookingDay} disabled={!!draft||busy||paused}
      onChange={value=>{setPickupSlot(value);setError("");}} availability={pickupAvailability}/>}
    {count>0&&scope&&mode==="pickup"&&suggestPickup&&<PickupSuggestion key={JSON.stringify([supplyDay,items])}
      date={supplyDay} items={items} onChoose={({date,start})=>{
        selectPickupDate(date,start);setAnnouncement("已帶入新的預約時段，請核對餐單後再送出。");
      }}/>}
    {count>0&&<label className="payChoice">付款方式<select value={method} disabled={!!draft||busy} onChange={e=>setMethod(e.target.value)}>
      {payments.methods.map(m=><option key={m} value={m}>{methods[m]}</option>)}</select>
      {method!=="cash"&&<small>{environmentLabel(payments.mode)}</small>}</label>}
    {offer?.discount>0&&<label className="comboChoice"><input type="checkbox" checked={Boolean(applied)} disabled={!!draft||busy}
      onChange={e=>setUseCombo(e.target.checked)}/><span>套用套餐優惠 <small>省 NT$ {offer.discount}</small></span></label>}
    <div className="total"><span>合計</span><b>NT$ {total}</b></div>
    {paused&&!invalid&&count>0&&!draft&&<p className="error">餐單已保留，恢復接單後可再送出。</p>}
    {limitBlocked&&!draft&&!error&&<p className="error" role="status">部分餐點已超過{supplyLabel}剩餘份數，請調整餐單。</p>}
    {loaded&&!draft&&!busy&&!invalid&&adjustments.length>0&&<section className="supplyReview" aria-label="供應份數調整">
      {!supplyReview||supplyReview.key!==adjustmentKey?<>
        {supplyReview&&<p role="status">餐點供應有更新，請重新核對。</p>}
        <button className="outline" onClick={()=>setSupplyReview({key:adjustmentKey})}>
          {supplyReview?"更新調整預覽":"查看份數調整"}
        </button>
      </>:<>
        <ul>{adjustments.map(({id,name,from,to})=><li key={id}>
          <strong>{name}</strong><span>{from} 份 → {to===0?"移除":to+" 份"}</span>
        </li>)}</ul>
        <div className="actions">
          <button className="outline" onClick={()=>setSupplyReview(null)}>取消調整</button>
          <button className="primary" onClick={applySupplyReview}>確認份數調整</button>
        </div>
      </>}
    </section>}
    {count>0&&loaded&&!invalid&&!blocked&&!paused&&!draft&&!busy&&!bookingDay&&pickupSlot===null&&<CartQuote key={quoteBody} body={quoteBody}/>}
    {error&&<p className="error" role="alert">{error}</p>}
    {draft&&!busy&&<div className="supplyReview">
      {sharedCheckout&&<p>已載入另一個分頁正在處理的餐單。</p>}
      {sendTimedOut&&<p>送單回覆逾時，已保留原餐單。</p>}
      <p role="status">{lookupMessages[lookupStatus]}</p>
      <button className="outline" disabled={lookupStatus==="checking"} onClick={()=>{
        setLookup({token:draft.token,status:"checking"});
        setLookupRevision(value=>value+1);
      }}>重新查詢送單結果</button>
    </div>}
    {scope&&!loaded&&(menuFailed?<div className="supplyReview"><p role="status">暫時無法確認餐點供應，餐單已保留。</p>
      <button className="outline" onClick={()=>refreshMenu(true)}>重新檢查供應</button></div>:
      <p role="status">正在確認餐點供應狀態…</p>)}
    <button className="primary full" disabled={busy||!count||invalid||(!draft&&(paused||blocked||pickupBlocked||!loaded||!payments.methods.includes(method)))} onClick={submit}><Check size={17}/>{busy?"送單中…":draft?"重試同一張訂單":paused?"暫停接單":"確認送出訂單"}</button></aside></div>
    <span className="sr" aria-live="polite">{announcement}</span></main><Footer/>
    <button className="mobileCart" onClick={()=>setPanel(true)}><ShoppingBag size={18}/> 我的餐單 · {count} 件 <b>NT$ {total}</b></button></>;
}
