export const reorderable = order => ["completed","cancelled"].includes(order.status);

export function reorderPlan(items, menu, unavailable, cart, remaining={}) {
  const dishes = new Map(menu.map(dish=>[dish.id,dish]));
  return items.map(({id,name,qty})=>{
    const dish = dishes.get(id);
    const reason = !dish ? "目前未販售" : unavailable.includes(id) ? "已售完" : "";
    const limit=Math.min(20,remaining[id]??20);
    const added = reason ? 0 : Math.max(0,Math.min(qty,limit-(cart[id]||0)));
    return {id,name:dish?.name??name,added,reason:reason||(added<qty?(limit<20?"今日剩餘 "+limit+" 份":"同品項最多 20 份"):"")};
  });
}
