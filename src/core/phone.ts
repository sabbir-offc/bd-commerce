import { ValidationError } from './errors.js'

/**
 * Bangladeshi mobile numbers in local form: 01 followed by an operator digit
 * and eight subscriber digits. Operator digits in service today are 3 to 9
 * (Grameenphone 7, Robi 8, Airtel 6, Banglalink 9, Teletalk 5, plus the
 * newer ranges 3 and 4).
 */
const BD_MOBILE = /^01[3-9]\d{8}$/

/** Digits only, no country code: `01712345678`. */
export type BdLocalPhone = string

/**
 * Accepts the shapes people actually paste into order forms and returns the
 * 11-digit local form that every courier API here expects.
 *
 * `+8801712345678`, `8801712345678`, `008801712345678`, `01712-345678`,
 * `1712345678` all normalize to `01712345678`.
 *
 * @throws {ValidationError} when the number is not a valid BD mobile number.
 */
export function normalizeBdPhone(input: string, provider = 'bd-commerce'): BdLocalPhone {
  if (typeof input !== 'string' || !input.trim()) {
    throw new ValidationError('Phone number is required', provider, 'phone')
  }

  const digits = input.replace(/\D/g, '')
  let local: string

  if (digits.startsWith('00880')) {
    local = `0${digits.slice(5)}`
  } else if (digits.startsWith('880')) {
    local = `0${digits.slice(3)}`
  } else if (digits.startsWith('01')) {
    local = digits
  } else if (digits.startsWith('1') && digits.length === 10) {
    local = `0${digits}`
  } else {
    local = digits
  }

  if (!BD_MOBILE.test(local)) {
    throw new ValidationError(
      `"${input}" is not a valid Bangladeshi mobile number`,
      provider,
      'phone',
    )
  }
  return local
}

/** Non-throwing counterpart of {@link normalizeBdPhone}. */
export function isBdPhone(input: string): boolean {
  try {
    normalizeBdPhone(input)
    return true
  } catch {
    return false
  }
}

/** `01712345678` to `+8801712345678`. Used by payment providers. */
export function toInternational(input: string, provider?: string): string {
  return `+880${normalizeBdPhone(input, provider).slice(1)}`
}
