import { createApp } from 'vue'
import App from './App.vue'

// 引入 vue-print-designer 的 Web Component 及样式（全局注册 <print-designer>）
import 'vue-print-designer'
import 'vue-print-designer/style.css'

createApp(App).mount('#app')
