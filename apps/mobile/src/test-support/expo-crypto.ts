import * as NodeCrypto from "node:crypto";

export const CryptoDigestAlgorithm = {
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA384: "SHA-384",
  SHA512: "SHA-512",
} as const;

export const CryptoEncoding = {
  HEX: "hex",
  BASE64: "base64",
} as const;

export function getRandomBytes(byteCount: number): Uint8Array {
  return new Uint8Array(NodeCrypto.randomBytes(byteCount));
}

export function randomUUID(): string {
  return NodeCrypto.randomUUID();
}

export async function digestStringAsync(
  algorithm: (typeof CryptoDigestAlgorithm)[keyof typeof CryptoDigestAlgorithm],
  value: string,
  options: { readonly encoding: (typeof CryptoEncoding)[keyof typeof CryptoEncoding] } = {
    encoding: CryptoEncoding.HEX,
  },
): Promise<string> {
  return NodeCrypto.createHash(algorithm).update(value).digest(options.encoding);
}
