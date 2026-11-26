import assert from "node:assert/strict";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {businessDayRange} from "../lib/business-day.mjs";
import {pickupRoster} from "../server/pickup-roster.mjs";
import {applyDemoMigrations} from "./apply-demo-migrations.mjs";
import {sqliteD1} from "./sqlite-d1.mjs";

const site=fileURLToPath(new URL("../",import.meta.url));

export async function buildPickupRosterFollowUpDemo(){
  const sqlite=new DatabaseSync(":memory:");
  try{
    const db=sqliteD1(sqlite),date="2026-11-26",slot=Date.parse(date+"T11:30:00+08:00"),minute=60_000;
    const boundary=slot+15*minute,scenes=[];
    await applyDemoMigrations(db,site);
    const add=sqlite.prepare(`INSERT INTO orders(id,token,mode,status,items,note,total,created,pickup_slot,status_history,
      pickup_arrived_at) VALUES (?,?,'pickup','ready',?,'',45,?,?,?,?)`);
    const addOrder=(id,readyAt,arrivedAt=null)=>add.run(id,crypto.randomUUID(),JSON.stringify([{id:"sencha",qty:1}]),
      slot-60*minute,slot,JSON.stringify([{from:"preparing",status:"ready",at:readyAt}]),arrivedAt);
    addOrder(71,slot+2*minute);
    addOrder(72,slot+5*minute,slot+3*minute);
    addOrder(73,slot+14*minute);
    async function capture(stage,capturedAt){
      const snapshot=await pickupRoster(db,date,businessDayRange(date),capturedAt,true);
      scenes.push({stage,snapshot});
    }
    await capture("before",boundary-1);
    await capture("due",boundary);
    sqlite.prepare("UPDATE orders SET pickup_arrived_at=? WHERE id=71").run(boundary+minute);
    sqlite.prepare("UPDATE orders SET status='completed' WHERE id=72").run();
    await capture("resolved",boundary+minute);
    assert.deepEqual(scenes.map(({snapshot})=>snapshot.followUp),[
      {unreported:0,arrived:0},{unreported:1,arrived:1},{unreported:0,arrived:0},
    ]);
    return {format:"hey-table.pickup-roster-followup-demo.v1",scenes};
  }finally{
    sqlite.close();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await buildPickupRosterFollowUpDemo(),null,2));
