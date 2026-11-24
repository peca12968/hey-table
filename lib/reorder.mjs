export const reorderable = order => ["completed","cancelled"].includes(order.status);

export function reorderPlan(items, menu, unavailable, cart) {
  const dishes = new Map(menu.map(dish=>[dish.id,dish]));
  return items.map(({id,name,qty})=>{
    const dish = dishes.get(id);
    const reason = !dish ? "目前未販售" : unavailable.includes(id) ? "已售完" : "";
    const added = reason ? 0 : Math.max(0,Math.min(qty,20-(cart[id]||0)));
    return {id,name:dish?.name??name,added,reason:reason||(added<qty?"同品項最多 20 份":"")};
  });
}
