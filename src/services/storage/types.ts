/** Where uploaded images live. Implementations: local disk, S3-compatible. */
export interface StorageProvider {
  readonly name: string;
  /** Store bytes at `key` and return the public URL. */
  put(key: string, body: Buffer, contentType: string): Promise<string>;
}
