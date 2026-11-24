import {itemNoteLimit} from "../lib/menu.mjs";

export function ItemNotesEditor({dishes,notes,disabled,onChange}){
  const count=dishes.filter(({id})=>notes[id]?.trim()).length;
  return <details className="itemNotes">
    <summary>品項備註{count>0&&<small> · 已填 {count} 項</small>}</summary>
    <p className="muted">每則備註會套用到該餐點的所有份數。</p>
    {dishes.map(dish=><label key={dish.id}>{dish.name}備註
      <input value={notes[dish.id]??""} disabled={disabled} maxLength={itemNoteLimit}
        onChange={event=>onChange(dish.id,event.target.value)}/>
    </label>)}
  </details>;
}

export function ItemNote({note}){
  return note?<small className="itemNote">備註　{note}</small>:null;
}
