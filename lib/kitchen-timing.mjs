import defaults from "@peca12968/pickup-window/demo-kitchen.json" with {type:"json"};

export const demoKitchen = defaults;
export const stationLabels = {hot:"熱台",cold:"冷台",bar:"飲品台",other:"其他餐點"};
export const stationBatchLimit = 20;

export function stationReview({table,pickupSlot,note,items}) {
  return JSON.stringify([table??null,pickupSlot??null,note??"",items]);
}
const sameKeys = (a,b) => a && typeof a==="object" && !Array.isArray(a) &&
  Object.keys(a).length===Object.keys(b).length && Object.keys(b).every(k=>Object.hasOwn(a,k));
function validSeconds(pair) {
  return Array.isArray(pair) && pair.length===2 &&
    pair.every(n=>Number.isSafeInteger(n) && n>=1 && n<=86400) && pair[0]<=pair[1];
}
export function importTiming(input) {
  if(!sameKeys(input?.stations,defaults.stations) || !sameKeys(input?.recipes,defaults.recipes))
    throw Error("請選擇包含目前全部餐點與工作站的廚房設定檔。");
  for(const [name,lanes] of Object.entries(defaults.stations))
    if(input.stations[name]!==lanes)throw Error("工作站容量與目前廚房不符。");
  const recipes={};
  for(const [id,recipe] of Object.entries(defaults.recipes)){
    const candidate=input.recipes[id];
    if(candidate?.station!==recipe.station || candidate?.batchSize!==recipe.batchSize)
      throw Error("餐點的分站或每批份數與目前廚房不符。");
    if(!validSeconds(candidate.seconds))throw Error("每批工時需為 1 至 86400 的整數秒，且最長不可短於最短。");
    recipes[id]={...recipe,seconds:[...candidate.seconds]};
  }
  return {stations:defaults.stations,recipes};
}

// A later menu revision may add dishes or move a recipe to a different station.
export function activeKitchen(stored) {
  if(!stored)return defaults;
  const recipes={};
  for(const [id,recipe] of Object.entries(defaults.recipes)){
    const old=stored.recipes[id];
    recipes[id]=old?.station===recipe.station && old.batchSize===recipe.batchSize && validSeconds(old.seconds)
      ? {...recipe,seconds:old.seconds} : recipe;
  }
  return {stations:defaults.stations,recipes};
}
export function timingChanges(before,after) {
  return Object.keys(defaults.recipes).filter(id=>before.recipes[id].seconds.some((n,i)=>n!==after.recipes[id].seconds[i]));
}
