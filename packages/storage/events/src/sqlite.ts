import Database from "better-sqlite3";

export type SQLiteRow = Record<string, unknown>;

export interface SQLiteStatement {
  get(...parameters: unknown[]): SQLiteRow | undefined;
  all(...parameters: unknown[]): SQLiteRow[];
  run(...parameters: unknown[]): void;
}

export interface SQLiteConnection {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  backup(destinationFile: string, options?: Database.BackupOptions): Promise<Database.BackupMetadata>;
  close(): void;
  readonly isTransaction: boolean;
}

export class SQLiteIntegerRangeError extends Error {
  constructor(column: string) {
    super(`SQLite integer in ${column} exceeds the JavaScript safe integer range`);
    this.name = "SQLiteIntegerRangeError";
  }
}

type NativeDatabase = InstanceType<typeof Database>;

export function openSQLiteConnection(
  filename: string,
  options: { readonly: boolean; timeout: number },
): SQLiteConnection {
  const database = new Database(filename, {
    readonly: options.readonly,
    fileMustExist: options.readonly,
    timeout: options.timeout,
  });
  database.defaultSafeIntegers(true);
  return new BetterSQLiteConnection(database);
}

class BetterSQLiteConnection implements SQLiteConnection {
  constructor(private readonly database: NativeDatabase) {}

  get isTransaction(): boolean {
    return this.database.inTransaction;
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  backup(destinationFile: string, options?: Database.BackupOptions): Promise<Database.BackupMetadata> {
    return this.database.backup(destinationFile, options);
  }

  prepare(sql: string): SQLiteStatement {
    const statement = this.database.prepare(sql);
    return {
      get(...parameters: unknown[]): SQLiteRow | undefined {
        const row = statement.get(...parameters);
        return row === undefined ? undefined : normalizeRow(row);
      },
      all(...parameters: unknown[]): SQLiteRow[] {
        return statement.all(...parameters).map(normalizeRow);
      },
      run(...parameters: unknown[]): void {
        statement.run(...parameters);
      },
    };
  }

  close(): void {
    this.database.close();
  }
}

function normalizeRow(value: unknown): SQLiteRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("SQLite returned a non-row result");
  }
  const row = { ...(value as Record<string, unknown>) };
  for (const [column, item] of Object.entries(row)) {
    if (typeof item !== "bigint") continue;
    if (item < -BigInt(Number.MAX_SAFE_INTEGER) || item > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SQLiteIntegerRangeError(column);
    }
    row[column] = Number(item);
  }
  return row;
}
