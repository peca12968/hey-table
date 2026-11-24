import {MenuPairs} from "@peca12968/menu-pairs";
import {dishes} from "../lib/menu.mjs";
import {businessDate,businessDayRange} from "../lib/business-day.mjs";
import {readRemaining} from "./daily-limits.mjs";

const offers = dishes.filter(dish => dish.group !== "丼飯").map(dish => dish.id);
const mains = new Set(dishes.filter(dish => dish.group === "丼飯").map(dish => dish.id));
const menuPairings = {katsudon: ["sencha", "gyoza"], oyakodon: ["edamame", "sencha"]};

export async function addOnFor(db, items) {
  const cart = items.map(item => item.id);
  const anchors = cart.filter(id => mains.has(id));
  if (!anchors.length) return null;
  const date=businessDate(Date.now());
  const [stock, history, limits] = await db.batch([
    db.prepare("SELECT dish FROM unavailable"),
    db.prepare("SELECT items FROM orders WHERE status='completed' ORDER BY id DESC LIMIT 200"),
    readRemaining(db,date,businessDayRange(date)),
  ]);
  const unavailable = [...stock.results.map(row=>row.dish),...limits.results.filter(row=>row.remaining===0).map(row=>row.dish)];
  if (cart.some(id => unavailable.includes(id))) return null;
  if (history.results.length >= 5) {
    const model = new MenuPairs({offers, k: offers.length, minPair: 2});
    for (const row of history.results) model.observe(JSON.parse(row.items).map(line => line.id));
    const best = model.rank(cart, unavailable).find(candidate => candidate.ordersWithOffer >= 2);
    if (best) return {id: best.id, source: best.evidence ? "pair" : "popular"};
  }
  const id = anchors.flatMap(anchor => menuPairings[anchor] ?? [])
    .find(offer => !cart.includes(offer) && !unavailable.includes(offer));
  return id ? {id, source: "menu"} : null;
}
