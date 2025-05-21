import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: 'jsdom',
    globals: true,
    // setupFiles: './setupVitest.ts', // if you have a setup file
    transformMode: { web: [/\.[jt]sx?$/] },
    deps: {
      optimizer: {
        web: {
          include: ['solid-js', 'solid-testing-library'],
        },
      },
      inline: [/solid-js/],
    },
  },
  resolve: {
    conditions: ['development', 'solid'],
  },
})
