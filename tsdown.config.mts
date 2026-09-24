import { defineConfig } from 'tsdown'

// host 半打包：把 src/index.ts 及 src/** 转译成 lib/（CJS），无类型检查。
// 用 .mts 避免 Node v24 原生 TS 剥离误伤配置。
//
// ⚠️ clean 刻意关闭：lib/ 里同时住着 host 半（index.cjs）与 client 半（client.js，
// 由 scripts/build-client.mjs 用 esbuild 生成）。若开启 clean，单独跑 host 构建
// 会把 client.js 一并删掉，导致界面卡片消失。清理各自产物由脚本自己负责。
export default defineConfig({
  entry: ['src/index.ts'],
  clean: false,
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  outDir: 'lib',
  // 不打包 node_modules（@deepseek-ai/* 由 DSH 运行时解析）
  skipNodeModulesBundle: true,
})
