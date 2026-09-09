import { describe, expect, it } from 'vitest'
import { isBdPhone, normalizeBdPhone, toInternational } from '../src/core/phone.js'
import { ValidationError } from '../src/core/errors.js'

describe('normalizeBdPhone', () => {
  it.each([
    ['01712345678', '01712345678'],
    ['+8801712345678', '01712345678'],
    ['8801712345678', '01712345678'],
    ['008801712345678', '01712345678'],
    ['1712345678', '01712345678'],
    ['01712-345678', '01712345678'],
    ['  017 1234 5678 ', '01712345678'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeBdPhone(input)).toBe(expected)
  })

  it.each([
    ['01212345678', 'retired operator prefix'],
    ['0171234567', 'too short'],
    ['017123456789', 'too long'],
    ['+919812345678', 'not a BD number'],
    ['', 'empty'],
    ['not a phone', 'non-numeric'],
  ])('rejects %s (%s)', (input) => {
    expect(() => normalizeBdPhone(input)).toThrow(ValidationError)
  })

  it('reports the failing field', () => {
    try {
      normalizeBdPhone('123', 'steadfast')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as ValidationError).field).toBe('phone')
      expect((error as ValidationError).provider).toBe('steadfast')
    }
  })
})

describe('isBdPhone', () => {
  it('does not throw on bad input', () => {
    expect(isBdPhone('01712345678')).toBe(true)
    expect(isBdPhone('nonsense')).toBe(false)
  })
})

describe('toInternational', () => {
  it('produces the +880 form', () => {
    expect(toInternational('01712345678')).toBe('+8801712345678')
    expect(toInternational('8801712345678')).toBe('+8801712345678')
  })
})
