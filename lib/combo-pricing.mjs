import {quoteCombos} from "@peca12968/combo-counter";
import {dishes} from "./menu.mjs";

export const comboVersion = "demo-v1";
const promotions = [
  {id:"pork-gyoza", main:"katsudon", side:"gyoza", price:230},
  {id:"pork-tea", main:"katsudon", side:"sencha", price:200},
  {id:"chicken-gyoza", main:"oyakodon", side:"gyoza", price:215},
];

export function priceCombos(items) {
  return quoteCombos(dishes, promotions, items);
}
