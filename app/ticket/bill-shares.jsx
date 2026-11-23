"use client";
import {useEffect,useState} from "react";
import {splitQuote,splitReceipt} from "@peca12968/table-shares";
import "./bill-shares.css";

function newDiner(id, items) {
  return {id, name:"用餐人 " + id, weights:Object.fromEntries(items.map(item => [item.id,"1"]))};
}

function restore(key, items) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key));
    if (Array.isArray(saved) && saved.length >= 2 &&
        new Set(saved.map(p => p.id)).size === saved.length &&
        saved.every(p => Number.isSafeInteger(p.id) && p.id > 0 && typeof p.name === "string" &&
          items.every(item => typeof p.weights?.[item.id] === "string"))) return saved;
  } catch {}
  return [newDiner(1,items), newDiner(2,items)];
}

function calculate(order, people) {
  const names = people.map(p => p.name.trim());
  if (names.some(name => !name) || new Set(names).size !== names.length)
    return {error:"請為每位用餐人填寫不同的稱呼。"};
  const shares = Object.create(null);
  for (const item of order.items) {
    const weights = Object.create(null);
    for (const [i, person] of people.entries()) {
      const raw = person.weights[item.id];
      const weight = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(weight))
        return {error:item.name + "的分攤份數請填 0 或正整數。"};
      if (weight) weights[names[i]] = weight;
    }
    if (!Object.keys(weights).length) return {error:"請至少指定一人分攤" + item.name + "。"};
    shares[item.id] = weights;
  }
  return {result:order.combo ? splitQuote(order.combo.quote,shares) : splitReceipt(order,shares)};
}

function Editor({order}) {
  const key = "he-ri-shares-v1:" + order.id + ":" + order.created;
  const [people,setPeople] = useState(() => restore(key,order.items));
  useEffect(() => {
    try { sessionStorage.setItem(key,JSON.stringify(people)); } catch {}
  },[key,people]);
  const {result,error} = calculate(order,people);
  function edit(id, update) {
    setPeople(list => list.map(person => person.id === id ? update(person) : person));
  }
  function add() {
    setPeople(list => [...list,newDiner(Math.max(...list.map(p => p.id)) + 1,order.items)]);
  }
  return <div className="shareEditor">
    <h3>誰一起分帳？</h3>
    {people.map((person,i) => <div className="sharePerson" key={person.id}>
      <label><span>用餐人 {i+1}</span><input value={person.name} maxLength={40}
        aria-label={"用餐人 "+(i+1)+"的稱呼"} onChange={e => edit(person.id,p => ({...p,name:e.target.value}))}/></label>
      {people.length>2 && <button type="button" className="textLink" aria-label={"移除用餐人 "+(i+1)}
        onClick={() => setPeople(list => list.filter(p => p.id !== person.id))}>移除</button>}
    </div>)}
    <button className="outline" type="button" onClick={add}>新增用餐人</button>
    <h3>餐點分攤</h3>
    <p>平分填 1，沒吃填 0。想按 2 比 1 分食，就分別填 2 和 1。</p>
    {order.items.map(item => <fieldset key={item.id} className="shareItem">
      <legend>{item.name} × {item.qty} · NT$ {order.combo?.quote.lines.find(line=>line.id===item.id)?.total ?? item.price*item.qty}</legend>
      {people.map((person,i) => {
        const name = person.name.trim() || "用餐人 "+(i+1);
        return <label key={person.id}><span>{name}</span>
          <input type="number" inputMode="numeric" min="0" step="1" value={person.weights[item.id]}
            aria-label={item.name+"・"+name+"的分攤份數"}
            onChange={e => edit(person.id,p => ({...p,weights:{...p.weights,[item.id]:e.target.value}}))}/>
          {result && <span>NT$ {result.lines[item.id][name] ?? 0}</span>}
        </label>;
      })}
    </fieldset>)}
    {error ? <p role="alert" className="error">{error}</p> :
      <section className="shareTotals" aria-label="每人應付" aria-live="polite">
        <h3>每人應付</h3>
        <dl>{people.map(person => <div key={person.id}><dt>{person.name.trim()}</dt>
          <dd>NT$ {result.diners[person.name.trim()]?.pay ?? 0}</dd></div>)}</dl>
        <div className="total"><span>全桌合計</span><strong>NT$ {result.total}</strong></div>
      </section>}
  </div>;
}

export default function BillShares({order}) {
  const [open,setOpen] = useState(null);
  return <section className="sheet shareSheet">
    <button type="button" className="shareToggle" aria-expanded={open===true} aria-controls="bill-share-editor"
      onClick={() => setOpen(value => !value)}>這張餐單怎麼分帳？<span aria-hidden="true">{open?"−":"＋"}</span></button>
    <div id="bill-share-editor" hidden={!open}>{open!==null && <Editor order={order}/>}</div>
  </section>;
}
