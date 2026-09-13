import { expect, test } from "bun:test";
import { validateMigrationSql } from "./migrationSafety.ts";
test('migration validation rejects commit aliases and external SQLite files but accepts trigger bodies', () => {
  for (const sql of ['CREATE TABLE t(id); END;', 'ABORT;', 'START TRANSACTION;', 'ATTACH DATABASE \'/tmp/x\' AS x;', 'PRAGMA writable_schema=ON;']) expect(() => validateMigrationSql(sql)).toThrow();
  expect(validateMigrationSql('CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES (CASE WHEN 1 THEN 2 END); END;')).toContain('TRIGGER');
  expect(() => validateMigrationSql('CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES(1); END; END;')).toThrow();
});
