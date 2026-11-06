/**
 * R4 / SEC-2 - the data at rest is no more readable than its source.
 *
 * The corpus this server copies from is 0600 files under 0700 directories; the
 * database, its WAL/SHM sidecars, the backups and the retention journal hold
 * the same prompts, paths and costs, so they get the same modes. Hook payloads
 * are redacted, but JSONL-derived rows are stored as they are.
 *
 * Modes are set explicitly where each file is created, not with
 * `process.umask`: a umask is process-global, and setting one throws in a
 * worker thread. SQLite gives `-wal` and `-shm` the mode of the database file,
 * so a private database file is what keeps its sidecars private.
 *
 * A directory that already exists is never chmod-ed, with one exception, the
 * server's own `backups` directory: `DASHBOARD_DB_PATH` may point into a folder
 * the operator shares for other reasons. Once the files are private an open
 * directory exposes names, not content, so the boot warns and carries on.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const GROUP_OTHER_BITS = 0o077;
const SQLITE_SIDECAR_SUFFIXES: readonly string[] = ['-wal', '-shm'];

/** The server's files that hold data, for the boot-time check. */
export interface DataPaths {
  readonly dbPath: string;
  readonly backupsDir: string;
  readonly journalPath: string;
}

/** Create `path` and any missing parents as 0700; an existing directory keeps its mode. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/**
 * Create `path` as 0600, or take an existing file to 0600, leaving its content
 * alone. The chmod is not redundant: the mode given to `open` applies only to a
 * file it creates, and only through the umask.
 */
export function ensurePrivateFile(path: string): void {
  closeSync(openSync(path, 'a', PRIVATE_FILE_MODE));
  chmodSync(path, PRIVATE_FILE_MODE);
}

function tightenIfPresent(path: string, mode: number): void {
  if (existsSync(path)) {
    chmodSync(path, mode);
  }
}

/**
 * Make a database file and any sidecars left by an older install or an unclean
 * shutdown private, BEFORE SQLite opens them: it reuses an existing sidecar.
 */
export function ensurePrivateDatabaseFiles(dbPath: string): void {
  ensurePrivateFile(dbPath);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    tightenIfPresent(`${dbPath}${suffix}`, PRIVATE_FILE_MODE);
  }
}

/** Regular files directly in a backups directory; a symlink is not followed. */
function listBackupFiles(backupsDir: string): readonly string[] {
  if (!existsSync(backupsDir)) {
    return [];
  }
  return readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(backupsDir, entry.name));
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

/**
 * Throw if any existing path grants group or other access. Exported separately
 * so the refusal is directly testable: on an ordinary filesystem the chmod in
 * {@link secureDataFiles} has already succeeded, so this fails only where a
 * chmod does not take effect (an exFAT or network volume).
 */
export function assertPrivateModes(paths: readonly string[]): void {
  const exposed = paths
    .filter((path) => existsSync(path))
    .map((path) => ({ path, mode: statSync(path).mode }))
    .filter(({ mode }) => (mode & GROUP_OTHER_BITS) !== 0)
    .map(({ path, mode }) => `${path} (mode ${octal(mode)})`);
  if (exposed.length > 0) {
    throw new Error(
      `Data files are readable beyond their owner: ${exposed.join(', ')}. ` +
        'Move the database to a filesystem that honours file modes; refusing to continue.',
    );
  }
}

/**
 * The startup permission check. Takes every data file an older install left
 * open to 0600 and the backups directory to 0700, verifies the result, and
 * warns when the database directory is open to group or other.
 */
export function secureDataFiles(paths: DataPaths, warn: (line: string) => void): void {
  const { dbPath, backupsDir, journalPath } = paths;
  const files = [
    dbPath,
    ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${dbPath}${suffix}`),
    journalPath,
    ...listBackupFiles(backupsDir),
  ];
  for (const file of files) {
    tightenIfPresent(file, PRIVATE_FILE_MODE);
  }
  tightenIfPresent(backupsDir, PRIVATE_DIR_MODE);
  assertPrivateModes([...files, backupsDir]);

  const dataDir = dirname(dbPath);
  const dirMode = statSync(dataDir).mode;
  if ((dirMode & GROUP_OTHER_BITS) !== 0) {
    warn(
      `database directory ${dataDir} has mode ${octal(dirMode)}: other accounts can list it. ` +
        `Its files are private; run "chmod 700 ${dataDir}" to close it.`,
    );
  }
}
