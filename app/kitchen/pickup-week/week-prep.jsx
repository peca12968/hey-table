import {dishes} from "../../../lib/menu.mjs";
import {downloadCsv} from "../../../lib/download-csv.mjs";

const names=new Map(dishes.map(dish=>[dish.id,dish.name]));
const dishName=id=>names.get(id)??id;

export default function WeekPrep({snapshot}){
  const days=snapshot.days.filter(day=>day.prep.length);
  const quantity=days.reduce((sum,day)=>sum+day.prep.reduce((total,item)=>total+item.pending+item.preparing,0),0);

  function exportPrep(){
    const capturedAt=new Date(snapshot.capturedAt).toISOString();
    const rows=[["取餐日期","品項編號","餐點","待接單份數","製作中未完成份數","合計份數","擷取時間（UTC）"],
      ...days.flatMap(({date,prep})=>prep.map(({id,pending,preparing})=>
        [date,id,dishName(id),pending,preparing,pending+preparing,capturedAt]))];
    downloadCsv(rows,"hey-table-pickup-prep-"+snapshot.days[0].date+"-"+capturedAt.replaceAll(":","-")+".csv");
  }

  return <details className="sheet pickupWeekPrep">
    <summary>七天備料需求 · {quantity} 份</summary>
    <section aria-label="七天備料需求">
      <p>按取餐日列出可製作的預約，已備妥的分站品項會扣除。已停收日期的既有預約仍列入。</p>
      {days.length?<div className="pickupWeekPrepDays">{days.map(({date,prep})=><table key={date} aria-label={date+" 備料需求"}>
        <caption><time dateTime={date}>{date}</time> · {prep.reduce((total,item)=>total+item.pending+item.preparing,0)} 份</caption>
        <thead><tr><th scope="col">餐點</th><th scope="col">待接單</th><th scope="col">製作中未完成</th></tr></thead>
        <tbody>{prep.map(({id,pending,preparing})=><tr key={id}><th scope="row">{dishName(id)}</th>
          <td>{pending}</td><td>{preparing}</td></tr>)}</tbody>
      </table>)}</div>:<p>這七天目前沒有待備料的自取品項。</p>}
      <button className="outline" disabled={!days.length} onClick={exportPrep}>下載備料 CSV</button>
    </section>
  </details>;
}
