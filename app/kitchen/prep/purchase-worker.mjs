import {quotePantryPurchase} from "../../../lib/pantry-purchase.mjs";

self.onmessage=({data:{plan,catalog}})=>{
  try{
    self.postMessage({report:quotePantryPurchase(plan,catalog)});
  }catch(error){
    self.postMessage({error:error.message});
  }
};
