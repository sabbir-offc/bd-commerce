/**
 * RSA for Nagad.
 *
 * This is the one file in the package that needs `node:crypto`, and it is why
 * `bd-commerce/nagad` is the one subpath that will not run on an edge runtime.
 * Nagad encrypts with RSAES-PKCS1-v1_5, which WebCrypto deliberately does not
 * implement — it offers only RSA-OAEP. There is no way to do this with the
 * platform crypto available in a worker.
 *
 * That constraint is contained here: {@link NagadCryptoProvider} is an
 * interface, so a caller on another runtime can supply their own RSA and use
 * the rest of the client unchanged.
 */
import {
  constants,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  privateDecrypt,
  publicEncrypt,
  type KeyObject,
} from 'node:crypto'

import { ConfigError } from '../core/errors.js'

const PROVIDER = 'nagad'

/**
 * Nagad's integration guide specifies SHA1withRSA, but the most widely used
 * Node and PHP implementations sign with SHA256 and work in production —
 * accounts appear to differ. Default to SHA256 and make it switchable; the
 * error on a failed verification says which to try.
 */
export type NagadSignatureAlgorithm = 'SHA256' | 'SHA1'

export interface NagadCryptoProvider {
  /** RSA-encrypt with Nagad's public key, returning base64. */
  encrypt(plaintext: string): string
  /** RSA-decrypt base64 ciphertext with the merchant private key. */
  decrypt(ciphertextBase64: string): string
  /** Sign with the merchant private key, returning base64. */
  sign(plaintext: string): string
  /** Verify a Nagad-issued signature over `plaintext`. */
  verify(plaintext: string, signatureBase64: string): boolean
}

export interface NodeCryptoOptions {
  /** Merchant private key: PEM, or the bare base64 Nagad's portal hands you. */
  merchantPrivateKey: string
  /** Nagad's public key, in either form. */
  nagadPublicKey: string
  /** Default `SHA256`. */
  signatureAlgorithm?: NagadSignatureAlgorithm
}

/** The default provider, backed by `node:crypto`. */
export function createNodeCrypto(options: NodeCryptoOptions): NagadCryptoProvider {
  const algorithm = options.signatureAlgorithm ?? 'SHA256'
  const privateKey = loadKey(options.merchantPrivateKey, 'PRIVATE')
  const publicKey = loadKey(options.nagadPublicKey, 'PUBLIC')

  return {
    encrypt(plaintext) {
      return publicEncrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(plaintext, 'utf8'),
      ).toString('base64')
    },

    decrypt(ciphertextBase64) {
      return privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(ciphertextBase64, 'base64'),
      ).toString('utf8')
    },

    sign(plaintext) {
      const signer = createSign(algorithm)
      signer.update(plaintext)
      signer.end()
      return signer.sign(privateKey, 'base64')
    },

    verify(plaintext, signatureBase64) {
      const verifier = createVerify(algorithm)
      verifier.update(plaintext)
      verifier.end()
      try {
        return verifier.verify(publicKey, Buffer.from(signatureBase64, 'base64'))
      } catch {
        // A malformed signature is a failed verification, not a crash.
        return false
      }
    },
  }
}

/**
 * Accepts a PEM block or the bare base64 Nagad gives you, with or without
 * line breaks, and returns a usable key. Getting this wrong is the most common
 * first-hour failure in a Nagad integration, so it is handled here rather than
 * left to the caller.
 */
function loadKey(key: string, kind: 'PRIVATE' | 'PUBLIC'): KeyObject {
  if (typeof key !== 'string' || !key.trim()) {
    throw new ConfigError(
      `\`${kind === 'PRIVATE' ? 'merchantPrivateKey' : 'nagadPublicKey'}\` is required`,
      PROVIDER,
    )
  }

  const pem = key.includes('-----BEGIN') ? key.trim() : toPem(key, kind)

  try {
    return kind === 'PRIVATE' ? createPrivateKey(pem) : createPublicKey(pem)
  } catch (error) {
    throw new ConfigError(
      `Could not read the Nagad ${kind.toLowerCase()} key. Expected PKCS#8 (${
        kind === 'PRIVATE' ? 'BEGIN PRIVATE KEY' : 'BEGIN PUBLIC KEY'
      }) or the bare base64 from the merchant portal. Underlying error: ${
        error instanceof Error ? error.message : String(error)
      }`,
      PROVIDER,
    )
  }
}

function toPem(base64: string, kind: 'PRIVATE' | 'PUBLIC'): string {
  const body = base64.replace(/\s+/g, '')
  const lines = body.match(/.{1,64}/g) ?? [body]
  return `-----BEGIN ${kind} KEY-----\n${lines.join('\n')}\n-----END ${kind} KEY-----\n`
}

/**
 * `yyyyMMddHHmmss` in Asia/Dhaka.
 *
 * Nagad rejects a timestamp that is not close to Dhaka local time, so a server
 * running in UTC — which most are — cannot just format `new Date()`.
 */
export function dhakaTimestamp(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00'

  // `hour` can come back as "24" at midnight in some ICU builds.
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${get('year')}${get('month')}${get('day')}${hour}${get('minute')}${get('second')}`
}

/** A random nonce for the initialize challenge. */
export function randomChallenge(bytes = 20): string {
  const buffer = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buffer)
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}
