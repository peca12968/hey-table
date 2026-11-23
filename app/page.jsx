"use client";
import {useEffect,useRef,useState} from "react";
import {Plus,Minus,ShoppingBag,X,Utensils,Check} from "lucide-react";
import {dishes,tables} from "../lib/menu.mjs";
import {Header,Footer,Mode,request} from "./shared";
import {cartKey,openReceipt,read,save} from "../lib/order-storage.mjs";

const groups=["全部","丼飯","小食","飲品"];
export default function Menu(){
  const [table,setTable]=useState(null),[scope,setScope]=useState(""),[group,setGroup]=useState("全部");
  const [cart,setCart]=useState({}),[note,setNote]=useState(""),[sold,setSold]=useState([]),[loaded,setLoaded]=useState(false);
  const [draft,setDraft]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[panel,setPanel]=useState(false);
  const [announcement,setAnnouncement]=useState(""); const sending=useRef(false);
  const [lookup,setLookup]=useState("");
  useEffect(()=>{
    const param=new URLSearchParams(location.search).get("table"), key=cartKey(param);
    setTable(param);setScope(key);const old=read(key,{});setCart(old.cart??{});setNote(old.note??"");setDraft(old.draft??null);
    if(old.draft && window.matchMedia("(max-width: 680px)").matches) setPanel(true);
    let live=true;
    const refresh=()=>request("/api/menu").then(data=>{if(live){setSold(data.unavailable);setLoaded(true);}}).catch(()=>{if(live)setLoaded(false);});
    refresh();const timer=setInterval(refresh,15000);return()=>{live=false;clearInterval(timer);};
  },[]);
  useEffect(()=>{if(scope)save(scope,{cart,note,draft});},[scope,cart,note,draft]);
  useEffect(()=>{
    if(!draft||busy||!scope)return;
    let current;
    async function findReceipt(){
      current?.abort();
      const controller=new AbortController();
      current=controller;
      setLookup("正在確認這張餐單是否已送達…");
      try{
        await request("/api/ticket",{headers:{"X-Ticket":draft.token},signal:controller.signal});
        if(!controller.signal.aborted && !sending.current) openReceipt(scope,draft.token);
      }catch(e){
        if(controller.signal.aborted || sending.current)return;
        setLookup(e.status===404 ? "目前查無這張訂單。請重試同一張訂單以送達廚房。" :
          "目前無法確認送單結果。恢復連線後會再查，也可重試同一張訂單。");
      }
    }
    findReceipt();
    window.addEventListener("online",findReceipt);
    return ()=>{current?.abort();window.removeEventListener("online",findReceipt);};
  },[scope,draft,busy]);
  useEffect(()=>{if(!panel)return;const close=e=>{if(e.key==="Escape")setPanel(false);};window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close);},[panel]);
  const invalid=table!==null&&!tables.includes(table), lines=dishes.filter(d=>cart[d.id]>0);
  const count=lines.reduce((s,d)=>s+cart[d.id],0), total=lines.reduce((s,d)=>s+d.price*cart[d.id],0);
  function change(id,delta){if(draft||busy)return;setCart(old=>({...old,[id]:Math.max(0,Math.min(20,(old[id]||0)+delta))}));setError("");setAnnouncement((dishes.find(d=>d.id===id)?.name??"")+"數量已更新");}
  async function submit(){
    if(sending.current||invalid||!scope||!count)return;
    sending.current=true;setBusy(true);setError("");
    const payload=draft??{token:crypto.randomUUID(),mode:table?"table":"pickup",table,note,items:lines.map(d=>({id:d.id,qty:cart[d.id]}))};
    setDraft(payload);save(scope,{cart,note,draft:payload});
    try{
      await request("/api/orders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      openReceipt(scope,payload.token);
    }catch(e){
      if([400,409,415].includes(e.status)){setDraft(null);setError(e.message);request("/api/menu").then(v=>setSold(v.unavailable)).catch(()=>{});}
      sending.current=false;setBusy(false);
    }
  }
  const hero=dishes[0],blocked=lines.some(d=>sold.includes(d.id));
  function addButton(d){return <button className="add" aria-label={"加入"+d.name} disabled={!loaded||busy||!!draft||sold.includes(d.id)||(cart[d.id]||0)>=20||invalid} onClick={()=>change(d.id,1)}><Plus size={18}/></button>;}
  return <><Header home/><main className="shell">
    <section className="hero"><div className="heroCopy"><p className="kicker"><span/> 本日主廚推薦</p><h1>{hero.name}</h1><p>{hero.description}</p><button className="heroAction" onClick={()=>change(hero.id,1)} disabled={!loaded||busy||!!draft||sold.includes(hero.id)||(cart[hero.id]||0)>=20||invalid}><Plus size={16}/> 加入餐單 <b>NT$ {hero.price}</b></button></div><img className="heroImg" src="/food/katsudon.webp" alt="滑蛋豬排丼"/></section>
    {invalid&&<p className="error" role="alert">桌號無效，請重新掃描桌牌。也可<a href="/">改為線上自取</a>。</p>}
    <div className="columns"><section><div className="menuTitle"><div><p className="eyebrow">OUR MENU</p><h2>點餐菜單</h2></div><Mode table={table}/></div>
    <nav className="tabs" aria-label="餐點分類">{groups.map(g=><button key={g} aria-pressed={group===g} onClick={()=>setGroup(g)}>{g}</button>)}</nav>
    <div className="grid">{dishes.filter(d=>group==="全部"||d.group===group).map(d=><article className="dish" key={d.id}><img src={"/food/"+d.id+".webp"} alt={d.name} loading="lazy"/><div className="dishInfo"><small>{d.group}</small><h3>{d.name}</h3><p>{d.description}</p><div className="price"><strong>NT$ {d.price}</strong>{sold.includes(d.id)?<span>已售完</span>:addButton(d)}</div></div></article>)}</div></section>
    {panel&&<button className="shade" aria-label="關閉餐單" onClick={()=>setPanel(false)}/>}
    <aside className={"cart "+(panel?"opened":"")} aria-label="我的餐單"><div className="cartHead"><h2><ShoppingBag size={21}/> 我的餐單</h2><span>{count} 件</span><button className="mobileClose" aria-label="關閉" onClick={()=>setPanel(false)}><X size={19}/></button></div>
    <div className="cartMode"><Mode table={table}/><span>現場付款</span></div>
    {!count?<div className="empty"><Utensils size={30}/><strong>餐單還是空的</strong><p>從菜單加入想吃的餐點</p></div>:<ul className="orderLines">{lines.map(d=><li key={d.id}><div><b>{d.name}{sold.includes(d.id)?"（售完）":""}</b><small>NT$ {d.price*cart[d.id]}</small></div><div className="stepper"><button disabled={!!draft||busy} aria-label={"減少"+d.name} onClick={()=>change(d.id,-1)}><Minus size={14}/></button><span>{cart[d.id]}</span><button disabled={!!draft||busy||sold.includes(d.id)||cart[d.id]>=20} aria-label={"增加"+d.name} onClick={()=>change(d.id,1)}><Plus size={14}/></button></div></li>)}</ul>}
    {count>0&&<label className="note">訂單備註 <small>選填</small><textarea placeholder="例如：餐具數量" value={note} maxLength={160} disabled={!!draft||busy} onChange={e=>setNote(e.target.value)}/></label>}
    <div className="total"><span>合計</span><b>NT$ {total}</b></div>
    {error&&<p className="error" role="alert">{error}</p>}{draft&&!busy&&lookup&&<p role="status">{lookup}</p>}{scope&&!loaded&&<p role="status">正在確認餐點供應狀態…</p>}
    <button className="primary full" disabled={busy||!count||invalid||(!draft&&(blocked||!loaded))} onClick={submit}><Check size={17}/>{busy?"送單中…":draft?"重試同一張訂單":"確認送出訂單"}</button></aside></div>
    <span className="sr" aria-live="polite">{announcement}</span></main><Footer/>
    <button className="mobileCart" onClick={()=>setPanel(true)}><ShoppingBag size={18}/> 我的餐單 · {count} 件 <b>NT$ {total}</b></button></>;
}
