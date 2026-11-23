"use client";
import {ChevronLeft,ClipboardList,Utensils,ShoppingBag} from "lucide-react";
export function Header({home=false}) {
  return <header className="mast"><div className="shell top"><a className="identity" href="/"><img src="/mark.svg" alt="" width="39" height="39"/><span>禾日食堂</span></a>
    {home ? <a href="/ticket" className="topLink"><ClipboardList size={17}/> 查詢餐單</a> : <a href="/" className="topLink"><ChevronLeft size={17}/> 返回菜單</a>}</div></header>;
}
export function Mode({table}) {return <span className="mode">{table?<Utensils size={15}/>:<ShoppingBag size={15}/>} {table?table+" 桌內用":"線上自取"}</span>;}
export function Footer(){return <footer className="shell bottom"><span>禾日食堂 · 點餐作品展示</span><div><a href="/tables">桌牌 QR</a><a href="/kitchen">店家後台</a></div></footer>;}
export async function request(url,options) {
  const res=await fetch(url,{cache:"no-store",...options});
  const body=await res.json();
  if(!res.ok){const e=new Error(body.error||"無法完成操作"); e.status=res.status;throw e;}
  return body;
}
