import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {title:"禾日食堂｜線上點餐", description:"日式丼飯、小食與茶飲。線上自取或掃描桌牌點餐。",icons:{icon:"/mark.svg"}};
export default function Layout({children}:{children:React.ReactNode}) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
