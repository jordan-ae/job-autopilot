import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The fixtures are saved pages: never let happy-dom load what they point at.
    environmentOptions: {
      happyDOM: {
        settings: {
          disableIframePageLoading: true,
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
        },
      },
    },
  },
})
