import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// <print-designer> 是 vue-print-designer 注册的 Web Component，
// 需要告诉 Vue 编译器把它当作自定义元素，而非待解析的 Vue 组件。
export default defineConfig({
  // 相对 base：部署到 GitHub Pages 任意子路径（用户页或项目页）都能正确加载资源，
  // 无需写死仓库名。飞书「自定义插件」填 https://<user>.github.io/<repo>/ 即可。
  base: './',
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag === 'print-designer',
        },
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
  },
})
