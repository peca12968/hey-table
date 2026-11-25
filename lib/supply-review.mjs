export function supplyReviewRows(dishes,cart,sold,maxFor){
  const available=new Map(dishes.map(({id})=>[id,sold.includes(id)?0:maxFor(id)]));
  return dishes.flatMap(({id,name,group})=>{
    const from=cart[id]??0,to=available.get(id);
    if(from<=to)return [];
    const missing=from-to;
    const alternatives=dishes.filter(dish=>dish.id!==id&&dish.group===group&&
      available.get(dish.id)-(cart[dish.id]??0)>=missing).map(dish=>({
      id:dish.id,name:dish.name,price:dish.price,max:available.get(dish.id),
    }));
    return [{id,name,from,to,alternatives}];
  });
}

export function planSupplyReview(cart,rows,choices){
  const next={...cart};
  for(const {id,from,to,alternatives} of rows){
    if(next[id]!==from)return null;
    next[id]=to;
    const choice=choices[id];
    if(!choice)continue;
    const alternative=alternatives.find(dish=>dish.id===choice);
    if(!alternative)return null;
    const total=(next[choice]??0)+from-to;
    if(total>alternative.max)return null;
    next[choice]=total;
  }
  return next;
}
