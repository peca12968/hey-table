import {useEffect,useState} from "react";
import {dishes} from "../../../lib/menu.mjs";

const label=capacity=>capacity===null?"不限量":capacity+" 份";

export default function CopyLimits({date,limits,disabled,loadSource,onCopy}){
  const [sourceDate,setSourceDate]=useState(""),[query,setQuery]=useState(null),[view,setView]=useState(null);
  const [selected,setSelected]=useState([]);
  useEffect(()=>{
    if(!query)return;
    const controller=new AbortController();
    loadSource(query.sourceDate,AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]))
      .then(source=>{if(!controller.signal.aborted)setView({query,source});})
      .catch(error=>{if(!controller.signal.aborted)setView({query,error:
        error.name==="TimeoutError"?"讀取來源設定逾時，請重試。":error.message});});
    return ()=>controller.abort();
  },[query,loadSource]);
  const current=view?.query===query?view:null;
  const changes=current?.source?dishes.flatMap(dish=>{
    const source=current.source.limits[dish.id],target=query.limits[dish.id];
    return source.capacity===target.capacity?[]:[{dish,source,target}];
  }):[];
  const reviewed=changes.filter(({dish})=>selected.includes(dish.id));
  const stale=reviewed.some(({dish,target})=>limits[dish.id].revision!==target.revision);

  async function apply(){
    if(disabled||stale||!reviewed.length)return;
    try{
      if(await onCopy({date,sourceDate:query.sourceDate,items:reviewed.map(({dish,source,target})=>({
        dish:dish.id,sourceRevision:source.revision,targetRevision:target.revision,
      }))})){
        setQuery(null);
        setSelected([]);
      }
    }catch{
      setQuery(null);
      setSelected([]);
    }
  }

  return <details className="sheet limitCopy">
    <summary>從其他日期複製上限</summary>
    <form className="actions limitDate" onSubmit={event=>{
      event.preventDefault();
      if(!sourceDate||sourceDate===date||disabled)return;
      setSelected([]);
      setQuery({sourceDate,limits});
    }}>
      <label>來源日期<input type="date" required value={sourceDate} disabled={disabled} onChange={event=>{
        setSourceDate(event.target.value);setQuery(null);setSelected([]);
      }}/></label>
      <button className="outline" disabled={!sourceDate||sourceDate===date||disabled}>讀取來源設定</button>
    </form>
    {sourceDate===date&&<p role="status">請選擇不同於目的日的來源日期。</p>}
    {query&&!current&&<p role="status">正在讀取來源設定…</p>}
    {current?.error&&<p className="error" role="alert">{current.error}</p>}
    {current?.source&&<section aria-label="複製上限比較">
      <p>目的日期 {date} · 僅複製品項上限，已成立的餐單保留。</p>
      {changes.length===0?<p>兩天的品項上限相同。</p>:<>
        <button className="outline" disabled={disabled||reviewed.length===changes.length}
          onClick={()=>setSelected(changes.map(({dish})=>dish.id))}>選取全部差異</button>
        <ul className="limitCopyChanges">
          {changes.map(({dish,source,target})=><li key={dish.id}>
            <label><input type="checkbox" checked={selected.includes(dish.id)} disabled={disabled}
              onChange={event=>setSelected(event.target.checked?[...selected,dish.id]:selected.filter(id=>id!==dish.id))}/>
              <span><strong>{dish.name}</strong><span>目的上限 {label(target.capacity)} → {label(source.capacity)}</span>
                <small>目的已占用 {limits[dish.id].used} 份{source.capacity!==null&&source.capacity<limits[dish.id].used?
                  " · 套用後暫停新的供應":""}</small></span>
            </label>
          </li>)}
        </ul>
        {stale&&<p role="status">目的設定已更新，請重新讀取後核對。</p>}
        <button className="primary" disabled={disabled||stale||!reviewed.length} onClick={apply}>套用已選上限</button>
      </>}
    </section>}
  </details>;
}
