import qrcode from "qrcode-generator";

export function qrImage(value){
  const code=qrcode(0,"M");
  code.addData(value);
  code.make();
  return code.createDataURL(6,24);
}
