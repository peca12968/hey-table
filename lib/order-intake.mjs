export const intakeLabels = {pickup:"線上自取",table:"掃碼內用"};

export function intakeNotice(mode,table=null) {
  return (table ? table+" 桌" : intakeLabels[mode])+"暫停接單。你可以保留餐單，待恢復後再送出。";
}
