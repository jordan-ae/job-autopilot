import PDFDocument from 'pdfkit'
import type { FileValue } from 'ats-form-fill'
import type { ApplyContext } from '../types.js'

/**
 * The documents an executor run attaches, as the fill engine takes them:
 * base64, so they survive being passed into the page as JSON.
 */

export function resumeFile(ctx: Pick<ApplyContext, 'resumePdf' | 'resumeFileName'>): FileValue {
  return { fileName: ctx.resumeFileName, mimeType: 'application/pdf', base64: ctx.resumePdf.toString('base64') }
}

/** The tailored letter as a plain one-page-or-more PDF, for forms that want
 * it as a file. Null when there is no letter. */
export async function coverLetterFile(ctx: Pick<ApplyContext, 'coverLetterText' | 'resumeFileName'>): Promise<FileValue | null> {
  const text = ctx.coverLetterText.trim()
  if (!text) return null
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 72 })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.font('Helvetica').fontSize(11).fillColor('#111827')
    for (const paragraph of text.split(/\n{2,}/)) doc.text(paragraph.trim(), { lineGap: 2, paragraphGap: 10 })
    doc.end()
  })
  return {
    fileName: ctx.resumeFileName.replace(/\.pdf$/i, '') + '-cover-letter.pdf',
    mimeType: 'application/pdf',
    base64: bytes.toString('base64'),
  }
}
