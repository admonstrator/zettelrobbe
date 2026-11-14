/*
 * Minimal types for the parts of jsonwebtoken the type-checked modules use.
 * The package ships no declarations and @types/jsonwebtoken is not installed;
 * extend this file when a checked module needs more of the API.
 */
declare module 'jsonwebtoken' {
  interface SignOptions {
    expiresIn?: string | number;
    [option: string]: unknown;
  }

  export function sign(
    payload: string | object | Buffer,
    secretOrPrivateKey: string,
    options?: SignOptions
  ): string;

  export function verify(
    token: string,
    secretOrPublicKey: string,
    options?: Record<string, unknown>
  ): any;
}
