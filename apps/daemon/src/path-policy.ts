import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class PathPolicy {
  readonly #roots: Set<string>;

  constructor(roots: string[]) {
    this.#roots = new Set(roots.map((root) => realpathSync(resolve(root))));
  }

  roots(): string[] {
    return [...this.#roots];
  }

  assertRoot(requestedRoot: string): string {
    const canonical = realpathSync(resolve(requestedRoot));
    if (!this.#roots.has(canonical)) throw new Error("Root is not allowed");
    return canonical;
  }

  resolveExisting(requestedRoot: string, requestedPath: string): string {
    const root = this.assertRoot(requestedRoot);
    const candidate = this.#lexicalCandidate(root, requestedPath);
    if (!existsSync(candidate)) throw new Error("Path does not exist");
    const canonical = realpathSync(candidate);
    this.#assertWithin(root, canonical);
    return canonical;
  }

  resolveForWrite(requestedRoot: string, requestedPath: string): string {
    const root = this.assertRoot(requestedRoot);
    const candidate = this.#lexicalCandidate(root, requestedPath);
    const parent = dirname(candidate);
    if (!existsSync(parent)) throw new Error("Parent directory does not exist");
    const canonicalParent = realpathSync(parent);
    this.#assertWithin(root, canonicalParent);
    if (!statSync(canonicalParent).isDirectory())
      throw new Error("Parent is not a directory");
    if (existsSync(candidate)) {
      const canonicalTarget = realpathSync(candidate);
      this.#assertWithin(root, canonicalTarget);
      return canonicalTarget;
    }
    return candidate;
  }

  assertDirectory(path: string): string {
    if (!isAbsolute(path))
      throw new Error("Working directory must be absolute");
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory())
      throw new Error("Working directory is not a directory");
    if (![...this.#roots].some((root) => isWithin(root, canonical))) {
      throw new Error("Working directory is outside all allowed roots");
    }
    return canonical;
  }

  #lexicalCandidate(root: string, requestedPath: string): string {
    if (isAbsolute(requestedPath))
      throw new Error("File path must be relative to its allowed root");
    const candidate = resolve(root, requestedPath || ".");
    this.#assertWithin(root, candidate);
    return candidate;
  }

  #assertWithin(root: string, candidate: string): void {
    if (!isWithin(root, candidate))
      throw new Error("Path escapes the allowed root");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return (
    delta === "" ||
    (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta))
  );
}
