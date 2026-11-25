import assert from "node:assert/strict";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {businessDate} from "../lib/business-day.mjs";
import {dishes} from "../lib/menu.mjs";
import {planSupplyReview,supplyReviewRows} from "../lib/supply-review.mjs";
import {api} from "../server/api.mjs";
import {applyDemoMigrations} from "./apply-demo-migrations.mjs";
import {sqliteD1} from "./sqlite-d1.mjs";

const site=fileURLToPath(new URL("../",import.meta.url));
const linesFor=cart=>dishes.flatMap(({id,name,price})=>cart[id]>0?[{id,name,price,qty:cart[id]}]:[]);
const subtotal=lines=>lines.reduce((total,line)=>total+line.qty*line.price,0);

export async function buildCartSupplyReviewDemo(){
  const sqlite=new DatabaseSync(":memory:");
  try{
    const db=sqliteD1(sqlite),env={DB:db,STAFF_KEY:"demo-only",TAPPAY_MODE:"demo"};
    await applyDemoMigrations(db,site);
    const date=businessDate(Date.now());
    const cart={gyoza:2,sencha:1},table="A05",paymentMethod="line_pay";
    const lines=linesFor(cart);
    const original={table,paymentMethod,lines,total:subtotal(lines)};
    async function call(path,{method="GET",input,token,staff=false,status=200}={}){
      const headers=new Headers({"Content-Type":"application/json"});
      if(token)headers.set("X-Ticket",token);
      if(staff)headers.set("Authorization","Bearer demo-only");
      const response=await api(new Request("https://demo.example/api/"+path,{
        method,headers,body:input===undefined?undefined:JSON.stringify(input),
      }),env);
      assert.equal(response.status,status);
      return response.json();
    }
    const supply=(dish,capacity,revision)=>call("kitchen/daily-limits",{method:"PATCH",staff:true,input:{date,dish,capacity,revision}});
    async function snapshot(){
      const {unavailable,remaining}=await call("menu?date="+date);
      const rows=supplyReviewRows(dishes,cart,unavailable,id=>Math.min(20,remaining[id]??20));
      assert.deepEqual(rows.map(row=>row.id),["gyoza"]);
      const {to,alternatives}=rows[0];
      const options=alternatives.map(({id,name,price,max})=>{
        const plan=planSupplyReview(cart,rows,{gyoza:id});
        return {id,name,price,available:max,total:subtotal(linesFor(plan))};
      });
      return {rows,preview:{remaining:to,options}};
    }
    const submit=(plan,token,status)=>call("orders",{method:"POST",status,input:{token,mode:"table",table,note:"",
      paymentMethod,paymentEnv:"demo",items:linesFor(plan).map(({id,qty})=>({id,qty}))}});
    await supply("gyoza",1,0);
    await supply("karaage",2,0);
    await supply("edamame",3,0);
    const before=await snapshot();
    const stale=planSupplyReview(cart,before.rows,{gyoza:"karaage"});
    await supply("karaage",0,1);
    const rejection=await submit(stale,"00000000-0000-4000-8000-000000000001",409);
    const after=await snapshot();
    assert.equal(planSupplyReview(cart,after.rows,{gyoza:"karaage"}),null);
    const selected=planSupplyReview(cart,after.rows,{gyoza:"edamame"});
    const token="00000000-0000-4000-8000-000000000002";
    await submit(selected,token,200);
    const {id,items,total,table:receiptTable,paymentMethod:method}=await call("ticket",{token});
    assert.deepEqual(items.map(({id,name,price,qty})=>({id,name,price,qty})),linesFor(selected));
    assert.deepEqual([receiptTable,method,total],[table,paymentMethod,subtotal(items)]);
    return {format:"hey-table.cart-supply-review-demo.v1",original,before:before.preview,after:after.preview,
      rejected:rejection.code,receipt:{id,table:receiptTable,paymentMethod:method,total,
        lines:items.map(({id,name,price,qty})=>({id,name,price,qty}))}};
  }finally{
    sqlite.close();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(await buildCartSupplyReviewDemo(),null,2));
}
