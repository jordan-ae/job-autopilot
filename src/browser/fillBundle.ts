import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: Promise<string> | null = null

/**
 * The fill engine (ats-form-fill) as one self-contained script, ready to
 * evaluate in a page. Once evaluated it leaves `__arkooFill` on the page's
 * global, and executor/driver.ts calls into it by name.
 *
 * A bundle rather than functions passed to `page.evaluate`: a function
 * serialised across loses its imports. ats-form-fill ships the bundle
 * prebuilt (`dist/fill.iife.js`); this reads it from next to the package's
 * entry point.
 */
export function buildFillBundle(): Promise<string> {
  cached ??= readFile(join(dirname(fileURLToPath(import.meta.resolve('ats-form-fill'))), 'fill.iife.js'), 'utf8')
  return cached
}
