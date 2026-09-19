import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    /* 这台机器（Termux/Android）上原生文件监听会漏事件：
       磁盘上文件已经改了，但 Vite 内存里还是旧模块，浏览器就会 import 到不存在的导出，
       整个模块图崩掉、整页白屏（而且没有任何报错）。改成轮询，宁可费一点 CPU。 */
    watch: { usePolling: true, interval: 800 },
  },
})
