/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

// 让 TS 在模板里把 <print-designer> 当作合法元素
declare module 'vue' {
  interface GlobalComponents {
    'print-designer': DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  }
}
