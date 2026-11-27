import fs from "node:fs/promises";
import os from "node:os";

export interface ProcessOwnerIdentity {
  host: string;
  pidNamespace: string;
}

/** Return an identity that can be compared with another process on this host. */
export async function currentProcessOwnerIdentity(): Promise<ProcessOwnerIdentity | undefined> {
  try {
    const host =
      process.platform === "linux"
        ? (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
        : os.hostname().trim();
    if (host === "") return undefined;
    const pidNamespace =
      process.platform === "linux"
        ? await fs.readlink("/proc/self/ns/pid")
        : `${process.platform}:host-pid-namespace`;
    return pidNamespace === "" ? undefined : { host, pidNamespace };
  } catch {
    return undefined;
  }
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function hadesLockReason(
  pid: number,
  identity: ProcessOwnerIdentity | undefined,
): string {
  if (identity === undefined) return `hades pid=${pid}`;
  return `hades pid=${pid} host=${encode(identity.host)} pidns=${encode(identity.pidNamespace)}`;
}

export function parseHadesLockReason(
  reason: string,
): { pid: number; identity: ProcessOwnerIdentity } | undefined {
  const match = /^hades pid=(\d+) host=([A-Za-z0-9_-]+) pidns=([A-Za-z0-9_-]+)$/.exec(reason);
  if (match === null) return undefined;
  try {
    const host = Buffer.from(match[2]!, "base64url").toString("utf8");
    const pidNamespace = Buffer.from(match[3]!, "base64url").toString("utf8");
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0 || host === "" || pidNamespace === "") {
      return undefined;
    }
    return { pid, identity: { host, pidNamespace } };
  } catch {
    return undefined;
  }
}
