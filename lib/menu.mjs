export const restaurant = "禾日食堂";
export const tables = Array.from({length: 8}, (_, i) => "A0" + (i + 1));
export const dishes = [
  {id:"katsudon", name:"滑蛋豬排丼", group:"丼飯", price:190, description:"金黃豬排、半熟風味滑蛋與特調醬汁，鋪在熱騰騰的白飯上。"},
  {id:"oyakodon", name:"雞肉親子丼", group:"丼飯", price:170, description:"雞肉與洋蔥以日式醬汁煮透，搭配柔嫩蛋香。"},
  {id:"karaage", name:"日式唐揚雞", group:"小食", price:110, description:"醬油醃製雞肉，現炸上桌，外酥內嫩。"},
  {id:"gyoza", name:"海苔柴魚煎餃", group:"小食", price:85, description:"金黃鍋貼搭配海苔與柴魚，適合分食。"},
  {id:"edamame", name:"鹽味毛豆", group:"小食", price:55, description:"清甜毛豆撒上海鹽，保留豆莢鮮香。"},
  {id:"sencha", name:"日式熱煎茶", group:"飲品", price:45, description:"清爽無糖，適合搭配丼飯與炸物。"},
];
export const labels = {pending:"等待接單",preparing:"製作中",ready:"可取餐",completed:"已完成",cancelled:"已取消"};
export const transitions = {pending:["preparing","cancelled"],preparing:["ready"],ready:["completed"],completed:[],cancelled:[]};
export const numberOf = id => String(id).padStart(4,"0");
export const itemNoteLimit = 80;

export function withItemNotes(items, notes){
  return items.map(item=>{
    const value=notes[item.id];
    const note=typeof value==="string"?value.trim():"";
    return note?{...item,note}:item;
  });
}
