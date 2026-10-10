import { validateProject } from "./operations";
import type { ProjectDocument } from "./types";
type DraftStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;
export interface RecoveryDraft {
  key: string;
  raw: string;
  document: ProjectDocument;
}
/** Each mounted editor owns a key. Session pointers recover reloads without sharing writers. */
export class DraftJournal {
  readonly prefix: string;
  readonly key: string;
  private previousKey: string | null;
  private adopted?: RecoveryDraft;
  constructor(
    private storage: DraftStorage,
    private session: Pick<Storage, "getItem" | "setItem">,
    readonly projectId: string,
    owner: string,
  ) {
    this.prefix = `capy.studio.draft.${projectId}`;
    this.key = `${this.prefix}.${owner}`;
    this.previousKey = session.getItem(this.prefix);
    session.setItem(this.prefix, this.key);
  }
  private read(key: string): RecoveryDraft | undefined {
    const raw = this.storage.getItem(key);
    if (!raw) return;
    try {
      const document = JSON.parse(raw);
      validateProject(document);
      if (document.id !== this.projectId) return;
      return { key, raw, document };
    } catch {
      return;
    }
  }
  recover() {
    return (
      this.read(this.key) ??
      (this.previousKey ? this.read(this.previousKey) : undefined) ??
      this.read(this.prefix)
    );
  }
  list() {
    const drafts: RecoveryDraft[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (
        key &&
        (key === this.prefix || key.startsWith(`${this.prefix}.`)) &&
        key !== this.key
      ) {
        const draft = this.read(key);
        if (draft) drafts.push(draft);
      }
    }
    return drafts;
  }
  write(document: ProjectDocument) {
    this.storage.setItem(this.key, JSON.stringify(document));
    this.session.setItem(this.prefix, this.key);
  }
  adopt(draft: RecoveryDraft) {
    this.adopted = draft;
    this.write(draft.document);
  }
  saved(document: ProjectDocument) {
    if (this.storage.getItem(this.key) === JSON.stringify(document)) {
      this.storage.removeItem(this.key);
      this.retirePredecessor(document);
    }
  }
  private retirePredecessor(document: ProjectDocument) {
    const draft = this.adopted;
    if (
      draft &&
      draft.key !== this.key &&
      draft.raw === JSON.stringify(document) &&
      this.storage.getItem(draft.key) === draft.raw
    )
      this.storage.removeItem(draft.key);
    this.adopted = undefined;
  }
  discard() {
    this.storage.removeItem(this.key);
    this.adopted = undefined;
  }
}
