import { createHash } from 'node:crypto'
import { FORM_HOSTS, type PostingRef } from 'ats-form-fill'
import { refFromUrl } from './navigator/target.js'
import type { Posting } from './store/types.js'
import { splitAtsJobId, type JobRow } from './types.js'

/** The ATS-hosted form for a posting the fill engine has a driver for, or null. */
export function postingRef(job: Pick<JobRow, 'ats' | 'ats_job_id' | 'apply_url'>): PostingRef | null {
  if (job.ats in FORM_HOSTS) {
    const parts = splitAtsJobId(job.ats_job_id)
    if (parts) return { ats: job.ats as PostingRef['ats'], board: parts.board, jobId: parts.jobId, applyUrl: job.apply_url }
  }
  return refFromUrl(job.apply_url)
}

/** A board slug as a company name: "maven-clinic" → "Maven Clinic". */
function nameFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * A posting from its link alone. A Greenhouse, Lever or Ashby link becomes a
 * posting the fill engine opens directly; anything else is a start page for
 * the navigator. The company defaults to the board's name, or the host's.
 */
export function postingFromUrl(
  url: string,
  details: { company?: string; role?: string; location?: string; description?: string; foundOn?: string } = {},
): Posting {
  const ref = refFromUrl(url)
  let host = ''
  try {
    host = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    throw new Error(`not a link: ${url}`)
  }
  return {
    id: createHash('sha256').update(url.trim()).digest('hex').slice(0, 16),
    company: details.company?.trim() || (ref ? nameFromSlug(ref.board) : host),
    role: details.role?.trim() ?? '',
    location: details.location?.trim() ?? '',
    apply_url: url.trim(),
    source_id: null,
    ats: ref?.ats ?? '',
    ats_job_id: ref ? `${ref.board}:${ref.jobId}` : '',
    description: details.description ?? '',
    found_on: details.foundOn?.trim() || null,
    active: true,
  }
}
