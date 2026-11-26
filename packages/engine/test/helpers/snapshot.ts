import { createHash } from "node:crypto";
import { readdirSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
import { git } from "./repo.js";

export interface RepoSnapshot {
  head: string;
  refs: string;
  index: string;
  status: string;
  stash: string;
  /** relative path -> sha256 of contents, for every file outside .git (node_modules included). */
  files: Record<string, string>;
}

function walk(root: string, rel: string, out: Record<string, string>): void {
  for (const name of readdirSync(path.join(root, rel)).sort()) {
    if (rel === "" && name === ".git") continue;
    const relPath = rel === "" ? name : `${rel}/${name}`;
    const abs = path.join(root, relPath);
    const st = lstatSync(abs);
    if (st.isDirectory()) walk(root, relPath, out);
    else if (st.isFile()) out[relPath] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    else if (st.isSymbolicLink()) out[relPath] = `link:${readlinkSync(abs)}`;
    else out[relPath] = `link:${st.mode}`;
  }
}

/** Capture everything summoning must not change: files, index, HEAD, refs and stash. */
export function snapshot(dir: string): RepoSnapshot {
  const files: Record<string, string> = {};
  walk(dir, "", files);
  let headResult = "";
  try {
    headResult = git(dir, "rev-parse", "--verify", "--quiet", "HEAD").trim();
  } catch {
    // No commits yet: HEAD does not resolve.
  }
  return {
    head: headResult,
    refs: git(dir, "for-each-ref", "--format=%(refname) %(objectname)"),
    index: git(dir, "ls-files", "--stage"),
    status: git(dir, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"),
    stash: git(dir, "stash", "list"),
    files,
  };
}
