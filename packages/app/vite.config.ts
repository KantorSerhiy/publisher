import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default ({ mode }) => {
   return defineConfig({
      plugins: [react()],
      define: {
         "process.env": JSON.stringify(mode),
      },
   });
};
