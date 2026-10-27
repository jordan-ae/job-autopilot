import { describe, expect, it } from 'vitest'
import { agentStartFrom } from './start.js'
import { classifyApplyTarget, formLinksIn, refFromUrl } from './target.js'

describe('refFromUrl', () => {
  it('reads the fill-engine forms the boards publish', () => {
    expect(refFromUrl('https://job-boards.greenhouse.io/mavenclinic/jobs/88643130')).toMatchObject({ ats: 'greenhouse', board: 'mavenclinic', jobId: '88643130' })
    expect(refFromUrl('https://boards.eu.greenhouse.io/acme/jobs/123?gh_src=x')).toMatchObject({ ats: 'greenhouse', board: 'acme', jobId: '123' })
    expect(refFromUrl('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=456')).toMatchObject({ ats: 'greenhouse', board: 'acme', jobId: '456' })
    expect(refFromUrl('https://jobs.lever.co/acme/0f3c3b4e-1a2b-4c5d-8e9f-0a1b2c3d4e5f/apply')).toMatchObject({ ats: 'lever', board: 'acme' })
    expect(refFromUrl('https://jobs.ashbyhq.com/snowflake/5db01aa4-92eb-4796-bd7e-446ea98402f2')).toMatchObject({ ats: 'ashby', board: 'snowflake' })
  })

  it('refuses a board page without a job', () => {
    expect(refFromUrl('https://jobs.ashbyhq.com/prior-labs')).toBeNull()
    expect(refFromUrl('https://job-boards.greenhouse.io/acme')).toBeNull()
    expect(refFromUrl('https://jobs.lever.co/acme/not-a-uuid')).toBeNull()
    expect(refFromUrl('not a url')).toBeNull()
  })
})

describe('classifyApplyTarget', () => {
  it('names the walls measured in the 2026-10-21 dry run', () => {
    expect(classifyApplyTarget('https://capitalone.wd12.myworkdayjobs.com/en-US/Capital_One/job/McLean-VA/Full-stack-Engineer-4_R1001687-1')).toMatchObject({ kind: 'account', system: 'workday' })
    expect(classifyApplyTarget('https://ejwl.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/26106676/apply/email')).toMatchObject({ kind: 'account', system: 'oracle' })
    expect(classifyApplyTarget('https://www.ziprecruiter.com/c/capital-one/Job/Full-stack-Engineer-4/-in-Mclean,VA?jid=b33')).toMatchObject({ kind: 'login', site: 'ziprecruiter' })
    expect(classifyApplyTarget('https://www.linkedin.com/jobs/view/123')).toMatchObject({ kind: 'login', site: 'linkedin' })
    expect(classifyApplyTarget('https://www.workatastartup.com/jobs/1234')).toMatchObject({ kind: 'login', site: 'workatastartup' })
  })

  it('follows listings and opens employer sites', () => {
    expect(classifyApplyTarget('https://news.ycombinator.com/item?id=49926228')).toMatchObject({ kind: 'listing', site: 'hn' })
    expect(classifyApplyTarget('https://remoteok.com/remote-jobs/123')).toMatchObject({ kind: 'listing' })
    expect(classifyApplyTarget('https://careers.marriott.com/flex-senior-full-stack-software-engineer/job/P1-6577711-0')).toEqual({ kind: 'open', host: 'careers.marriott.com' })
    expect(classifyApplyTarget('')).toMatchObject({ kind: 'invalid' })
  })
})

describe('formLinksIn and agentStartFrom', () => {
  it('finds a form link in an HN-style description, entities and all', () => {
    const text = 'Apply: https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;prior-labs&#x2F;5db01aa4-92eb-4796-bd7e-446ea98402f2. Thanks!'
    expect(formLinksIn(text)).toEqual(['https://jobs.ashbyhq.com/prior-labs/5db01aa4-92eb-4796-bd7e-446ea98402f2'])
  })

  it('starts from the one linked form, even when the apply link is walled', () => {
    const start = agentStartFrom('https://www.linkedin.com/jobs/view/1', 'Apply at https://jobs.lever.co/acme/0f3c3b4e-1a2b-4c5d-8e9f-0a1b2c3d4e5f')
    expect(start).toMatchObject({ kind: 'go', target: { kind: 'fill', ref: { ats: 'lever', board: 'acme' } } })
  })

  it('does not guess between several linked forms', () => {
    const many = 'https://jobs.lever.co/acme/0f3c3b4e-1a2b-4c5d-8e9f-0a1b2c3d4e5f and https://jobs.lever.co/acme/1f3c3b4e-1a2b-4c5d-8e9f-0a1b2c3d4e5f'
    expect(agentStartFrom('https://news.ycombinator.com/item?id=1', many)).toMatchObject({ kind: 'go', target: { kind: 'listing' } })
  })

  it('hands a walled link straight back with its code and sentence', () => {
    const start = agentStartFrom('https://www.ziprecruiter.com/c/capital-one/Job/x', '')
    expect(start).toMatchObject({ kind: 'walled', code: 'login_required' })
    expect(start.kind === 'walled' && start.reason).toMatch(/ZipRecruiter/)
    expect(agentStartFrom('https://acme.wd1.myworkdayjobs.com/x', '')).toMatchObject({ kind: 'walled', code: 'account_required' })
  })
})
