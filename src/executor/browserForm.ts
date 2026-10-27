import type { BrowserSession } from '../browser/provider.js'
import type { PostingRef } from 'ats-form-fill'
import { playwrightDriver, type FormDriver } from './driver.js'

/** An element each ATS renders once its form is ready to take input. */
const READY: Record<PostingRef['ats'], string> = {
  greenhouse: '#application-form',
  ashby: '.ashby-application-form-field-entry',
  lever: '#application-form',
}

/**
 * Open the employer's hosted form in a fresh page of `session`, wait for it
 * to render, and load the fill engine into it. The page belongs to the
 * session: closing the session discards it and everything typed into it.
 */
export async function openFormPage(session: BrowserSession, url: string, ats: PostingRef['ats'], bundle: string): Promise<FormDriver> {
  const page = await session.context.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  // A form that never renders is read as what it is (closed, a wall, an
  // error page) by classifyPage, not treated as a crash here.
  await page.waitForSelector(READY[ats], { timeout: 20_000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await page.evaluate(bundle)
  return playwrightDriver(page, bundle)
}
