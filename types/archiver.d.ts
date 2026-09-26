// archiver 8 ships no types and @types/archiver (v7) predates the class exports.
declare module "archiver" {
  import type { Readable, Transform } from "node:stream";
  interface EntryData { name: string; date?: Date }
  export class Archiver extends Transform {
    append(source: Readable | Buffer | string, data: EntryData): this;
    file(path: string, data: EntryData): this;
    directory(dir: string, dest: string | false): this;
    finalize(): Promise<void>;
    on(event: "error" | "warning", listener: (e: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  export class ZipArchive extends Archiver {
    constructor(options?: { zlib?: { level?: number }; store?: boolean; comment?: string });
  }
  export class TarArchive extends Archiver {
    constructor(options?: { gzip?: boolean });
  }
  export class JsonArchive extends Archiver {}
}
