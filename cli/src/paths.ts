import { statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/** Socket directory: per user, outside $TMPDIR so every process finds the same path. */
export function socketDir(): string {
	if (process.platform === "win32") return `\\\\.\\pipe\\sitegeist-bridge-${userInfo().username}`;
	return `/tmp/sitegeist-bridge-${userInfo().username}`;
}

export function socketPath(pid: number): string {
	if (process.platform === "win32") return `${socketDir()}-${pid}`;
	return join(socketDir(), `${pid}.sock`);
}

/**
 * Refuse a directory or socket that another user could have planted: it must be
 * ours, not a symlink, and closed to everyone else. Mirrors what Claude Code checks.
 */
export function assertSecurePath(path: string, expected: "dir" | "socket"): void {
	if (process.platform === "win32") return;
	const st = statSync(path, { throwIfNoEntry: true });
	if (st.isSymbolicLink()) throw new Error(`${path} is a symlink`);
	if (st.uid !== process.getuid?.()) throw new Error(`${path} is owned by another user`);
	const mode = st.mode & 0o777;
	if (expected === "dir") {
		if (!st.isDirectory()) throw new Error(`${path} is not a directory`);
		if (mode !== 0o700) throw new Error(`${path} has mode ${mode.toString(8)}, expected 700`);
	} else {
		if (!st.isSocket()) throw new Error(`${path} is not a socket`);
		if (mode & 0o077) throw new Error(`${path} is accessible to other users (mode ${mode.toString(8)})`);
	}
}
