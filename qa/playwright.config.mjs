import {defineConfig} from "@playwright/test";
export default defineConfig({testDir:".",testMatch:"*.spec.mjs",workers:1,timeout:45000,
  use:{baseURL:"http://127.0.0.1:18841",browserName:"chromium"},
  webServer:{command:"node server.mjs",url:"http://127.0.0.1:18841/api/menu",timeout:60000}});
