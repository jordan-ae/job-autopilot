import { describe, expect, it } from 'vitest'
import { postingFromUrl, postingRef } from './posting.js'

describe('postingFromUrl', () => {
  it('reads a fill-engine form straight from its link, and names the company after the board', () => {
    const posting = postingFromUrl('https://job-boards.greenhouse.io/mavenclinic/jobs/88643130')
    expect(posting).toMatchObject({ ats: 'greenhouse', ats_job_id: 'mavenclinic:88643130', company: 'Mavenclinic', active: true })
    expect(postingRef(posting)).toMatchObject({ ats: 'greenhouse', board: 'mavenclinic', jobId: '88643130' })
  })

  it('leaves anything else to the navigator, under the host’s name unless told otherwise', () => {
    const posting = postingFromUrl('https://careers.example.com/jobs/42', { role: 'Engineer' })
    expect(posting).toMatchObject({ ats: '', ats_job_id: '', company: 'careers.example.com', role: 'Engineer' })
    expect(postingRef(posting)).toBeNull()
    expect(postingFromUrl('https://careers.example.com/jobs/42', { company: 'Example' }).company).toBe('Example')
  })

  it('gives the same link the same id', () => {
    expect(postingFromUrl('https://jobs.lever.co/acme/2b444752-0000-4000-8000-000000000000').id).toBe(
      postingFromUrl(' https://jobs.lever.co/acme/2b444752-0000-4000-8000-000000000000 ').id,
    )
  })

  it('refuses something that is not a link', () => {
    expect(() => postingFromUrl('not a url')).toThrow(/not a link/)
  })
})
