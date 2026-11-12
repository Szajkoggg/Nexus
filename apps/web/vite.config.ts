import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const server = `http://127.0.0.1:${process.env.NEXUS_PORT ?? 4317}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": server,
      "/ws": { target: server.replace("http", "ws"), ws: true },
    },
  },
});
