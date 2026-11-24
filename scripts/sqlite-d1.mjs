// D1 statement operations used by local SQLite-backed tests and demos.
export function sqliteD1(sqlite) {
  const wrap=(stmt,args=[])=>({bind:(...values)=>wrap(stmt,values),first:()=>stmt.get(...args),
    run:()=>({meta:stmt.run(...args)}),all:()=>({results:stmt.all(...args)})});
  return {sqlite,prepare:sql=>wrap(sqlite.prepare(sql)),batch(statements){
    sqlite.exec("BEGIN");
    try{
      const results=statements.map(stmt=>stmt.all());
      sqlite.exec("COMMIT");
      return results;
    }catch(e){sqlite.exec("ROLLBACK");throw e;}
  }};
}
