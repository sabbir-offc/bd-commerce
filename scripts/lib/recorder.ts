/**
 * Shared machinery for the provider smoke tests.
 *
 * Both scripts do the same three things: record every HTTP exchange with
 * secrets and customer data masked, diff the response keys against the types in
 * `src/`, and leave a transcript that is safe to paste into an issue. The
 * per-provider scripts supply only what differs.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FetchLike } from '../../src/core/http.js'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface Exchange {
  step: string
  endpoint: string
  method: string
  url: string
  /** Auth headers are masked, so this is safe to share. */
  requestHeaders: Record<string, unknown>
  requestBody: unknown
  status: number
  responseBody: unknown
  durationMs: number
}

/**
 * Keys a response is expected to carry. `nested` describes objects one level
 * down, such as Steadfast's `consignment`.
 */
export interface KeySpec {
  required: string[]
  optional?: string[]
  nested?: Record<string, KeySpec>
}

export interface RecorderOptions {
  /** Collapses a full URL to a stable endpoint name used as the spec key. */
  endpointOf: (url: string) => string
  /** Field and header names whose values must never reach the transcript. */
  secretKeys: string[]
}

export interface Recorder {
  fetchImpl: FetchLike
  transcript: Exchange[]
  /** Labels every exchange that follows, so a transcript reads as a story. */
  step: (name: string) => void
}

export function createRecorder(options: RecorderOptions): Recorder {
  const transcript: Exchange[] = []
  const secrets = new Set(options.secretKeys.map((key) => key.toLowerCase()))
  let currentStep = 'setup'

  const fetchImpl: FetchLike = async (url, init = {}) => {
    const startedAt = Date.now()
    const response = await fetch(url, init)
    // The client still needs to read the body, so work off a clone.
    const text = await response.clone().text()

    transcript.push({
      step: currentStep,
      endpoint: options.endpointOf(url),
      method: init.method ?? 'GET',
      url,
      requestHeaders: redactRecord(headersToRecord(init.headers), secrets),
      requestBody: redact(
        parseMaybeJson(typeof init.body === 'string' ? init.body : undefined),
        secrets,
      ),
      status: response.status,
      responseBody: redact(parseMaybeJson(text), secrets),
      durationMs: Date.now() - startedAt,
    })

    return response
  }

  return {
    fetchImpl,
    transcript,
    step(name) {
      currentStep = name
    },
  }
}

/**
 * The actual verification: does the live API return what our types promise?
 * Missing required keys are defects in this package, not in the provider.
 * Returns true if anything drifted.
 */
export function reportShapeDrift(
  transcript: Exchange[],
  expected: Record<string, KeySpec>,
): boolean {
  heading('Response shape vs the types in src/')

  let drifted = false
  let printed = 0

  for (const exchange of transcript) {
    const spec = expected[exchange.endpoint]
    if (!spec) continue
    if (!isRecord(exchange.responseBody)) continue
    printed++
    if (exchange.status >= 400) {
      // An error body is a different shape by design. Comparing it against the
      // success spec would report drift that does not exist.
      console.log(
        `  ${'n/a'.padEnd(6)} ${exchange.endpoint.padEnd(22)} ${exchange.step} (HTTP ${exchange.status})`,
      )
      continue
    }

    const problems = diffKeys(exchange.responseBody, spec, '')
    const missing = problems.filter((p) => p.kind === 'missing').map((p) => p.path)
    const unknown = problems.filter((p) => p.kind === 'unknown').map((p) => p.path)

    const verdict = missing.length ? 'DRIFT' : unknown.length ? 'extra' : 'ok'
    console.log(`  ${verdict.padEnd(6)} ${exchange.endpoint.padEnd(22)} ${exchange.step}`)
    if (missing.length) {
      drifted = true
      console.log(`         missing: ${missing.join(', ')}`)
    }
    if (unknown.length) {
      console.log(`         unknown: ${unknown.join(', ')}`)
    }
  }

  if (printed === 0) {
    console.log('  (nothing to check — no recognized responses were recorded)')
  }
  if (drifted) {
    console.log('\n  Missing keys mean the types in this package are wrong, not the provider.')
    console.log('  Fix the types and the client mapping, then re-run.')
  }
  return drifted
}

interface KeyProblem {
  kind: 'missing' | 'unknown'
  path: string
}

function diffKeys(body: Record<string, unknown>, spec: KeySpec, prefix: string): KeyProblem[] {
  const optional = spec.optional ?? []
  const nested = spec.nested ?? {}
  const known = new Set([...spec.required, ...optional, ...Object.keys(nested)])
  const actual = Object.keys(body)

  const problems: KeyProblem[] = []

  for (const key of spec.required) {
    if (!actual.includes(key)) problems.push({ kind: 'missing', path: prefix + key })
  }
  for (const key of Object.keys(nested)) {
    if (!actual.includes(key)) problems.push({ kind: 'missing', path: prefix + key })
  }
  for (const key of actual) {
    if (!known.has(key)) problems.push({ kind: 'unknown', path: prefix + key })
  }

  for (const [key, childSpec] of Object.entries(nested)) {
    const child = body[key]

    if (isRecord(child)) {
      problems.push(...diffKeys(child, childSpec, `${prefix}${key}.`))
      continue
    }
    // List endpoints put the keys worth checking inside array elements. One
    // element is enough: a homogeneous list drifts as a whole.
    if (Array.isArray(child) && isRecord(child[0])) {
      problems.push(...diffKeys(child[0], childSpec, `${prefix}${key}[0].`))
    }
  }

  return problems
}

/** Writes the transcript under `.smoke/` and returns its path. */
export function writeTranscript(prefix: string, transcript: Exchange[]): string {
  const dir = join(ROOT, '.smoke')
  mkdirSync(dir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(dir, `${prefix}-${stamp}.json`)
  writeFileSync(path, `${JSON.stringify(transcript, null, 2)}\n`, 'utf8')
  return path
}

function redact(value: unknown, secrets: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets))
  if (!isRecord(value)) return value
  return redactRecord(value, secrets)
}

function redactRecord(
  record: Record<string, unknown>,
  secrets: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = secrets.has(key.toLowerCase()) ? mask(value) : redact(value, secrets)
  }
  return result
}

function mask(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value)
  // Keep enough to tell two values apart without revealing either.
  return text.length <= 8 ? '[redacted]' : `[redacted:${text.length}:...${text.slice(-4)}]`
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key.toLowerCase()] = value
    })
    return result
  }
  const entries = Array.isArray(headers) ? headers : Object.entries(headers)
  for (const [key, value] of entries) result[String(key).toLowerCase()] = String(value)
  return result
}

export function parseMaybeJson(text: string | undefined): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Thrown for anything the operator can fix by re-running with better arguments. */
export class UsageError extends Error {}

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new UsageError(
      `${name} is not set. Copy .env.example to .env and fill it in; the smoke scripts load .env automatically.`,
    )
  }
  return value
}

/** Value after `--flag`, or undefined. */
export function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

export function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`)
}

export function field(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(12)}${value}`)
}

/** pnpm forwards the `--` separator into argv; drop it. */
export function argv(): string[] {
  return process.argv.slice(2).filter((arg) => arg !== '--')
}
