import { describe, expect, it } from 'vitest'
import { introducesNewNumbers, newNumbersIn, numbersIn } from './facts.js'

describe('numbersIn', () => {
  it('normalises thousands separators and decimals', () => {
    expect([...numbersIn('Cut costs by 1,200 (12.5%) over 3 quarters')]).toEqual(['1200', '12.5', '3'])
  })

  it('folds spelled-out quantities to digits', () => {
    expect([...numbersIn('Mentored three engineers across two teams')]).toEqual(['3', '2'])
  })

  it('ignores digits inside identifiers but keeps trailing units', () => {
    expect([...numbersIn('Playwright e2e suite at p75, 4.1s, 35%, React 18')]).toEqual(['4.1', '35', '18'])
  })

  it('folds k and M suffixes so "12k" and "12,000" are the same claim', () => {
    expect([...numbersIn('12k lines, 1.2k stars, 3M users, 12,000 rows')]).toEqual(['12000', '1200', '3000000'])
  })

  it('does not treat the pronoun "one" as a quantity', () => {
    expect(numbersIn('one flow, owned end to end').size).toBe(0)
  })
})

describe('introducesNewNumbers', () => {
  const source = 'Led the rewrite of the checkout flow, cutting p75 load time from 4.1s to 1.8s; mentored three juniors'

  it('allows a rewrite that only restates the numbers already there', () => {
    expect(introducesNewNumbers('Cut p75 load time from 4.1s to 1.8s; mentored 3 juniors', source)).toBe(false)
  })

  it('catches a figure the source never stated, in digits or words', () => {
    expect(newNumbersIn('Cut p75 load time 56% across five squads', source)).toEqual(['56', '5'])
  })

  it('accepts a precomputed allow-list', () => {
    expect(introducesNewNumbers('Shipped 15+ components', numbersIn('React 18 + TypeScript'))).toBe(true)
    expect(introducesNewNumbers('Upgraded to React 18', numbersIn('React 18 + TypeScript'))).toBe(false)
  })
})
