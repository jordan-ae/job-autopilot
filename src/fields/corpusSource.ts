import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** One question on a captured form, as the classifier sees it. */
export interface CorpusQuestion {
  ats: 'greenhouse' | 'ashby' | 'lever'
  /** The fixture the question came from. */
  form: string
  company: string
  key: string
  kind: string
  label: string
  description?: string
  section?: string
  required: boolean
  options?: string[]
}

/** Options kept per question: enough for decline options and number ranges,
 * not the 240-country list. */
const MAX_OPTIONS = 40

/** Read every captured form under `dir` (test/fixtures/forms) into corpus
 * questions: the 455 real questions the classifier is measured against. */
export function corpusFromFixtures(dir: string): CorpusQuestion[] {
  const out: CorpusQuestion[] = []
  for (const ats of ['greenhouse', 'ashby', 'lever'] as const) {
    const atsDir = join(dir, ats)
    if (!existsSync(atsDir)) continue
    for (const file of readdirSync(atsDir).filter((name) => name.endsWith('.fields.json')).sort()) {
      const slug = file.replace(/\.fields\.json$/, '')
      const metaPath = join(atsDir, `${slug}.meta.json`)
      const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, 'utf8')) as { company?: string }) : {}
      const fields = JSON.parse(readFileSync(join(atsDir, file), 'utf8')) as Array<{
        key: string
        kind: string
        label: string
        description: string
        section: string
        required: boolean
        options: string[]
      }>
      for (const field of fields) {
        out.push({
          ats,
          form: slug,
          company: meta.company ?? '',
          key: field.key,
          kind: field.kind,
          label: field.label,
          ...(field.description ? { description: field.description.slice(0, 300) } : {}),
          ...(field.section ? { section: field.section } : {}),
          required: field.required,
          ...(field.options.length ? { options: field.options.slice(0, MAX_OPTIONS) } : {}),
        })
      }
    }
  }
  return out
}
