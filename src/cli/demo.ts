import { createServer, type Server } from 'node:http'
import PDFDocument from 'pdfkit'

/**
 * A careers site on localhost, for trying the agent without touching a real
 * employer: a job page whose Apply link leads to a one-page application form,
 * and a thank-you page when that form is sent. Nothing leaves the machine.
 *
 * The form asks what real forms ask: who you are, where you may work, a
 * written question, the CV, and an optional equal-opportunity question the
 * agent must leave alone.
 */

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1f2328}
label{display:block;margin-top:14px;font-weight:600}input,select,textarea{display:block;width:100%;margin-top:4px;padding:6px;font:inherit}
textarea{min-height:90px}button,.apply{display:inline-block;margin-top:20px;padding:8px 16px;background:#1f6feb;color:#fff;border:0;border-radius:6px;text-decoration:none;font:inherit}
.hint{color:#59636e;font-weight:400}</style></head><body>${body}</body></html>`

const JOB = page(
  'Platform Engineer — Example Labs',
  `<p>Example Labs · London or remote (UK)</p>
<h1>Platform Engineer</h1>
<p>We build developer tools. You'll own our build and deploy pipeline and help the rest of the team ship faster.</p>
<p>You have shipped TypeScript in production and care about developer experience.</p>
<a class="apply" href="/jobs/42/apply">Apply for this job</a>`,
)

const FORM = page(
  'Apply — Platform Engineer — Example Labs',
  `<h1>Apply: Platform Engineer</h1>
<form id="application" method="post" action="/jobs/42/apply" enctype="multipart/form-data">
  <label for="first_name">First name *</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last name *</label><input id="last_name" name="last_name" required>
  <label for="email">Email *</label><input id="email" name="email" type="email" required>
  <label for="phone">Phone</label><input id="phone" name="phone" type="tel">
  <label for="linkedin">LinkedIn profile</label><input id="linkedin" name="linkedin">
  <label for="authorized">Are you legally authorized to work in the United Kingdom? *</label>
  <select id="authorized" name="authorized" required><option value="">Select…</option><option>Yes</option><option>No</option></select>
  <label for="sponsorship">Will you now or in the future require visa sponsorship? *</label>
  <select id="sponsorship" name="sponsorship" required><option value="">Select…</option><option>Yes</option><option>No</option></select>
  <label for="notice">What is your notice period?</label><input id="notice" name="notice">
  <label for="project">Describe a technical project you are most proud of. *</label><textarea id="project" name="project" required></textarea>
  <label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" accept=".pdf" required>
  <label for="gender">Gender <span class="hint">(voluntary)</span></label>
  <select id="gender" name="gender"><option value="">Select…</option><option>Woman</option><option>Man</option><option>Non-binary</option><option>I prefer not to say</option></select>
  <button type="submit">Submit application</button>
</form>`,
)

const THANKS = page('Application received — Example Labs', `<h1>Thank you for applying!</h1><p>Your application has been submitted. We'll be in touch.</p>`)

export interface DemoSite {
  /** Where the job page is. */
  jobUrl: string
  /** How many applications the form has received. */
  received(): number
  close(): Promise<void>
}

export async function startDemoSite(): Promise<DemoSite> {
  let received = 0
  const server: Server = createServer((req, res) => {
    const send = (status: number, html: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    }
    if (req.method === 'GET' && req.url === '/jobs/42') return send(200, JOB)
    if (req.method === 'GET' && req.url === '/jobs/42/apply') return send(200, FORM)
    if (req.method === 'POST' && req.url === '/jobs/42/apply') {
      // The body is read and dropped: the demo keeps nothing.
      req.on('data', () => {})
      req.on('end', () => {
        received++
        send(200, THANKS)
      })
      return
    }
    send(404, page('Not found', '<h1>Page not found</h1>'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    jobUrl: `http://127.0.0.1:${port}/jobs/42`,
    received: () => received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** A one-page placeholder CV, so the demo has a real PDF to attach. */
export function placeholderCv(name: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.font('Helvetica-Bold').fontSize(18).text(name)
    doc.moveDown(0.5).font('Helvetica').fontSize(11).text('Placeholder CV for the job-autopilot demo. Not a real applicant.')
    doc.end()
  })
}
