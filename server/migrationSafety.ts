import { DbError } from "../shared.ts";
import { sqlTokens } from "./sqlSafety.ts";

export function validateMigrationSql(sql: string, dialect: "sqlite" | "postgres" = "postgres"): string {
  const script = sql.trim();
  if (!script || script.length > 1_000_000) throw new DbError('sql', 'Migration must contain SQL and fit within 1 MB');
  const tokens = sqlTokens(script, dialect);
  let first = true;
  let trigger = false;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (first && token !== ';') {
      if (['BEGIN', 'START', 'COMMIT', 'END', 'ABORT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'PREPARE', 'ATTACH', 'DETACH', 'VACUUM', 'PRAGMA'].includes(token)) {
        throw new DbError('sql', `Transaction control and nontransactional operations (${token}) are managed by the migration runner`);
      }
      trigger = token === 'CREATE' && tokens.slice(i + 1, i + 4).includes('TRIGGER');
      first = false;
    }
    if (trigger && (token === 'BEGIN' || token === 'CASE')) depth++;
    if (trigger && token === 'END') depth--;
    if (token === ';' && depth === 0) { first = true; trigger = false; }
  }
  return script;
}
