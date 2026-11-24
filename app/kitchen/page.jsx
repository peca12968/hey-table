"use client";
import {useEffect,useState} from "react";
import {RefreshCw} from "lucide-react";
import {Header,Footer,Mode,request} from "../shared";
import {dishes,labels,numberOf,tables,transitions} from "../../lib/menu.mjs";
import {downloadJson} from "../../lib/download-json.mjs";
import Timing from "./timing";
import ReturnReceipt from "./return-receipt";
import PaymentSnapshot from "./payment-snapshot";
import Intake from "./intake";
import {methods,paymentStates,environmentLabel,canPrepare,canCancel} from "../../lib/payments.mjs";
const action={preparing:"接單製作",ready:"完成製作",completed:"完成交餐",cancelled:"取消訂單"};
export default function Kitchen(){
  const [key,setKey]=useState(""),[entry,setEntry]=useState(""),[denied,setDenied]=useState(false),[rows,setRows]=useState(null);
  const [sold,setSold]=useState([]),[filter,setFilter]=useState("active"),[error,setError]=useState(""),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false);
  const [exporting,setExporting]=useState(false),[exportMessage,setExportMessage]=useState("");
  const [scope,setScope]=useState("all"),[search,setSearch]=useState("");
  const [signInTarget,setSignInTarget]=useState("/kitchen");
  useEffect(()=>{
    setKey(sessionStorage.getItem("he-ri-staff")||"");
    const pickup=new URLSearchParams(location.search).get("pickup");
    const id=Number(pickup);
    if(!/^[0-9]+$/.test(pickup??"")||!Number.isSafeInteger(id)||id<1)return;
    const number=numberOf(id);
    setSignInTarget("/kitchen?pickup="+number);
    setScope("pickup");
    setSearch(number);
    setFilter("all");
  },[]);
  useEffect(()=>{
    let live=true,inFlight=false;
    const load=async()=>{if(inFlight)return;inFlight=true;try{const [orders,menu]=await Promise.all([request("/api/kitchen",{headers:key?{Authorization:"Bearer "+key}:{}}),request("/api/menu")]);
      if(live){setRows(orders);setSold(menu.unavailable);setDenied(false);setError("");}
    }catch(e){if(live){if(e.status===403){setDenied(true);setRows(null);}setError(e.message);}}finally{inFlight=false;}};
    load();const t=setInterval(load,5000);return()=>{live=false;clearInterval(t);};
  },[key,revision]);
  async function update(endpoint,body){
    setBusy(true);setError("");
    try{await request("/api/kitchen/"+endpoint,{method:"PATCH",headers:{"Content-Type":"application/json",...(key?{Authorization:"Bearer "+key}:{})},body:JSON.stringify(body)});setRevision(v=>v+1);}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  async function exportStations(){
    setExporting(true);setExportMessage("");
    try{
      const snapshot=await request("/api/kitchen/stations",{headers:key?{Authorization:"Bearer "+key}:{}});
      downloadJson("hey-table-stations-",snapshot.capturedAt,snapshot);
      const count=snapshot.orders.filter(order=>order.status==="preparing").length;
      setExportMessage("已匯出 "+snapshot.orders.length+" 張訂單，其中 "+count+" 張製作中。");
    }catch(e){setExportMessage("匯出失敗："+e.message);}
    finally{setExporting(false);}
  }
  const ticket=search.trim().normalize("NFKC").replace(/^#\s*/,"");
  const validNumber=!search.trim()||/^\d+$/.test(ticket);
  const exactNumber=ticket.replace(/^0+(?=\d)/,"");
  const filtered=(rows??[]).filter(r=>{
    const statusMatches=filter==="all"||(filter==="active"?!["completed","cancelled"].includes(r.status):r.status===filter);
    const scopeMatches=scope==="all"||scope===r.mode||scope===r.table;
    return statusMatches&&scopeMatches&&validNumber&&(!exactNumber||exactNumber===String(r.id));
  });
  return <><Header/><main className="shell section"><div className="menuTitle"><div><p className="eyebrow">KITCHEN</p><h1>店家接單台</h1></div><button className="outline" onClick={()=>setRevision(v=>v+1)}><RefreshCw size={16}/> 更新</button></div>
    {error&&<p className="error" role="alert">{error}</p>}
    {denied?<div className="sheet"><h2>店員登入</h2><p>託管網站請使用獲授權的店主帳號。</p><a className="primary" href={"/signin-with-chatgpt?return_to="+encodeURIComponent(signInTarget)} target="_top">使用 ChatGPT 登入</a>
      <details><summary>使用自架店員金鑰</summary><form onSubmit={e=>{e.preventDefault();sessionStorage.setItem("he-ri-staff",entry);setKey(entry);setEntry("");setRevision(v=>v+1);}}><label>店員金鑰<input type="password" value={entry} onChange={e=>setEntry(e.target.value)} required/></label><button className="outline">登入</button></form></details></div>:rows===null?<p>正在讀取接單台…</p>:<>
    <div className="actions"><a className="outline" href="/kitchen/prep">查看備料單</a>
      <button className="outline" disabled={exporting} onClick={exportStations}>{exporting?"正在擷取訂單…":"下載分站出單檔"}</button></div>
    {exportMessage&&<p role="status">{exportMessage}</p>}
    <Intake key={"intake-"+key} staffKey={key}/>
    <ReturnReceipt key={key} staffKey={key}/>
    <PaymentSnapshot key={"payments-"+key} staffKey={key}/>
    <nav className="tabs" aria-label="餐單狀態">{[["active","處理中"],["pending","待接單"],["ready","待交餐"],["all","含近期結單"]].map(([v,n])=><button aria-pressed={v===filter} key={v} onClick={()=>setFilter(v)}>{n}</button>)}</nav>
    <div className="kitchenFilters">
      <label>管道或桌號<select value={scope} onChange={e=>setScope(e.target.value)}>
        <option value="all">全部管道</option><option value="pickup">線上自取</option><option value="table">全部內用</option>
        {tables.map(table=><option key={table} value={table}>{table} 桌</option>)}
      </select></label>
      <label>取餐號碼<input type="search" inputMode="numeric" value={search} placeholder="例如 0007"
        aria-invalid={!validNumber} aria-describedby="kitchen-filter-count" onChange={e=>setSearch(e.target.value)}/></label>
      <button className="outline" disabled={scope==="all"&&!search} onClick={()=>{setScope("all");setSearch("");}}>清除搜尋條件</button>
    </div>
    <p id="kitchen-filter-count" className="muted" aria-live="polite">{!validNumber?"請輸入完整的取餐號碼。":
      filtered.length?"符合條件 "+filtered.length+" 張餐單":"目前沒有符合條件的訂單。"}</p>
    <div className="kGrid">{filtered.map(r=><article className="sheet kitchenTicket" key={r.id}><div className="menuTitle"><h2>#{numberOf(r.id)}</h2><Mode table={r.table}/></div><p><b>{labels[r.status]}</b> · {new Date(r.created).toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Taipei"})}</p><ul className="orderLines">{r.items.map(d=><li key={d.id}>{d.name}<b>×{d.qty}</b></li>)}</ul>{r.note&&<p>備註　{r.note}</p>}<p>{methods[r.paymentMethod]} {r.paymentMethod!=="cash"&&[environmentLabel(r.paymentEnv),paymentStates[r.paymentState]].join(" · ")}</p><div className="total"><span>合計</span><b>NT$ {r.total}</b></div>
      <div className="actions">
        {["ready","completed"].includes(r.status)&&<a className="outline" href={"/kitchen/handoff?id="+numberOf(r.id)}>交餐小票</a>}
        {["sandbox","production"].includes(r.paymentEnv)&&<button className="outline" disabled={busy} onClick={()=>update("payment",{id:r.id})}>查詢金流</button>}
        {transitions[r.status].map(s=><button disabled={busy||(s==="cancelled"?!canCancel(r):!canPrepare(r))} className={s==="cancelled"?"outline":"primary"} key={s}
          onClick={()=>{if(s!=="cancelled"||window.confirm("取消這張訂單？"))update("status",{id:r.id,from:r.status,to:s});}}>{action[s]}</button>)}
      </div></article>)}</div>
    <section className="sheet stock"><h2>餐點供應</h2>{dishes.map(d=><div key={d.id}><span>{d.name}</span><button className="outline" disabled={busy} onClick={()=>update("availability",{id:d.id,available:sold.includes(d.id)})}>{sold.includes(d.id)?"已售完 · 恢復供應":"供應中 · 標記售完"}</button></div>)}</section>
    <Timing staffKey={key}/>
    {key&&<button className="outline" onClick={()=>{sessionStorage.removeItem("he-ri-staff");setKey("");}}>登出金鑰</button>}</>}</main><Footer/></>;
}
