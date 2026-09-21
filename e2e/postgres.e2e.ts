import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const sql = (query: string) => execFileSync('docker', ['compose', '-f', 'compose.verify.yml', 'exec', '-T', 'postgres', 'psql', '-U', 'tern', '-d', 'tern_verify', '-v', 'ON_ERROR_STOP=1', '-Atc', query], { encoding: 'utf8' }).trim();

test('real PostgreSQL: connect, browse, stage, commit, query, migrate and restore', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveTitle('Tern — Database Workbench');
  await test.step('Create and test a real saved connection', async () => {
    await page.getByRole('button', { name: 'New connection', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Connection manager' });
    await dialog.getByLabel('Name', { exact: true }).fill('Docker PostgreSQL');
    await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1');
    await dialog.getByLabel('Port', { exact: true }).fill('15432');
    await dialog.getByLabel('Database', { exact: true }).fill('tern_verify');
    await dialog.getByLabel('Username', { exact: true }).fill('tern');
    await dialog.getByRole('button', { name: 'Test Connection' }).click();
    await expect(dialog.getByRole('status')).toContainText('Connected: PostgreSQL');
    await dialog.getByRole('button', { name: 'Save & Connect' }).click();
    await page.getByRole('combobox', { name: 'Database', exact: true }).selectOption('postgres');
    await page.getByRole('combobox', { name: 'Database', exact: true }).selectOption('tern_verify');
    await page.getByRole('button', { name: /verify.users.*3c/ }).click();
    await page.getByRole('button', { name: 'Remove Docker PostgreSQL', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Close this connection’s documents before removing it.');
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove Docker PostgreSQL', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'User 001', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add row', exact: true })).toBeDisabled();
  });
  await test.step('Server paging and sorting', async () => {
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'User 125', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await page.getByRole('button', { name: 'Sort by name', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'User 001', exact: true })).toBeVisible();
  });
  await test.step('Export all excludes hidden columns', async () => {
    await page.getByRole('button', { name: 'Columns 3/3', exact: true }).click();
    await page.getByLabel('email', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Columns 2/3', exact: true }).click();
    await page.getByLabel('Export format', { exact: true }).selectOption('json');
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export all', exact: true }).click();
    const rows = JSON.parse(readFileSync((await (await downloaded).path())!, 'utf8'));
    expect(rows).toHaveLength(125);
    expect(rows.every((row: object) => !('email' in row))).toBe(true);
    await page.getByRole('button', { name: 'Columns 2/3', exact: true }).click();
    await page.getByLabel('email', { exact: true }).check();
    await page.getByRole('button', { name: 'Columns 3/3', exact: true }).click();
  });
  await test.step('Staging does not write; reviewed transaction commits', async () => {
    await page.getByRole('button', { name: 'Read Only', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Enable writes?' });
    await expect(confirmation).toBeVisible();
    for (const viewport of [{ width: 1440, height: 900 }, { width: 480, height: 800 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(async () => {
        const box = await confirmation.boundingBox();
        return box ? Math.max(Math.abs(box.x + box.width / 2 - viewport.width / 2), Math.abs(box.y + box.height / 2 - viewport.height / 2)) : Infinity;
      }).toBeLessThan(2);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('dialog', { name: 'Enable writes?' }).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Read Only', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Read Only', exact: true }).click();
    await page.getByRole('dialog', { name: 'Enable writes?' }).getByRole('button', { name: 'Enable writes', exact: true }).click();
    await expect(page.getByRole('button', { name: '● Writable', exact: true })).toBeVisible();
    await page.getByRole('cell', { name: 'User 001', exact: true }).dblclick();
    await page.getByLabel('Edit row 1 name', { exact: true }).fill('Edited by Playwright');
    await page.getByLabel('Edit row 1 name', { exact: true }).press('Enter');
    expect(sql('SELECT name FROM verify.users WHERE id=1')).toBe('User 001');
    sql("INSERT INTO verify.users VALUES (0, 'AAA inserted concurrently', 'concurrent@example.test')");
    await page.getByRole('button', { name: 'Refresh catalog', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review 1 change', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'AAA inserted concurrently', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Review 1 change', exact: true }).click();
    await page.getByRole('button', { name: 'Apply transaction', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Review row changes' })).toBeHidden();
    expect(sql('SELECT name FROM verify.users WHERE id=1')).toBe('Edited by Playwright');
    expect(sql('SELECT name FROM verify.users WHERE id=0')).toBe('AAA inserted concurrently');
    sql('DELETE FROM verify.users WHERE id=0');
    await page.getByRole('button', { name: 'Refresh catalog', exact: true }).click();
  });
  await test.step('Insert distinguishes explicit empty text from database default', async () => {
    for (const id of [126, 127]) {
      await page.getByRole('button', { name: 'Add row', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add row', exact: true });
      await dialog.getByLabel('New id', { exact: true }).fill(String(id));
      await dialog.getByLabel('New email', { exact: true }).fill(`user${id}@example.test`);
      if (id === 126) await dialog.getByLabel('Use default for name', { exact: true }).uncheck();
      await dialog.getByRole('button', { name: 'Stage row', exact: true }).click();
      await page.getByRole('button', { name: 'Review 1 change', exact: true }).click();
      await page.getByRole('button', { name: 'Apply transaction', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Review row changes' })).toBeHidden();
      expect(sql(`SELECT name FROM verify.users WHERE id=${id}`)).toBe(id === 126 ? '' : 'Default user');
    }
  });
  await test.step('Execute SQL against PostgreSQL', async () => {
    await page.getByRole('button', { name: 'SQL', exact: true }).click();
    await page.locator('.cm-content[contenteditable=true]:visible').pressSequentially('SELECT count(*) AS verified_users FROM verify.users;');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByRole('cell', { name: '127', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Query 1', exact: true })).toBeVisible();
  });
  await test.step('Run all preserves transaction rollback on a later error', async () => {
    const editor = page.locator('.cm-content[contenteditable=true]:visible');
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially("BEGIN; UPDATE verify.users SET name='should rollback' WHERE id=1; SELECT missing_column FROM verify.users; ROLLBACK;");
    await page.getByRole('button', { name: 'Run all', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Result 1 · error', exact: true })).toBeVisible();
    expect(sql('SELECT name FROM verify.users WHERE id=1')).toBe('Edited by Playwright');
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('SELECT count(*) AS verified_users FROM verify.users;');
    await expect(page.getByRole('tab', { name: 'Query 1', exact: true })).toBeVisible();
  });
  await test.step('Schema changes reset positional filters and writable EXPLAIN shows its plan', async () => {
    const editor = page.locator('.cm-content[contenteditable=true]:visible');
    const run = async (statement: string) => {
      await editor.press('ControlOrMeta+a');
      await editor.pressSequentially(statement);
      await page.getByRole('button', { name: 'Run all', exact: true }).click();
    };
    await run("CREATE TABLE verify.marker (); CREATE TABLE verify.filter_test (id integer, last text); INSERT INTO verify.filter_test VALUES (1, '100%_!'), (2, '1000');");
    await page.getByRole('button', { name: /verify.filter_test.*2c/ }).click();
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.getByTitle('Add rule', { exact: true }).click();
    await page.locator('select').filter({ has: page.locator('option', { hasText: 'last (text)' }) }).selectOption('1');
    await page.getByPlaceholder('value', { exact: true }).fill('100%_!');
    await expect(page.getByRole('cell', { name: '100%_!', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '1000', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
    await run('ALTER TABLE verify.filter_test DROP COLUMN last;');
    await page.getByRole('tab', { name: 'verify.filter_test', exact: true }).click();
    await expect(page.getByText('(match everything)', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
    await run('UPDATE verify.filter_test SET id=id RETURNING id AS returned_id;');
    await expect(page.getByRole('columnheader', { name: 'Column 1', exact: true })).toBeVisible();
    await run('EXPLAIN ANALYZE UPDATE verify.filter_test SET id=id+10;');
    await expect(page.getByRole('columnheader', { name: 'QUERY PLAN', exact: true })).toBeVisible();
    expect(sql('SELECT sum(id) FROM verify.filter_test')).toBe('23');
    await page.getByRole('button', { name: /verify.marker.*0c/ }).click();
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(page.locator('button[title="Add rule"]:visible')).toBeDisabled();
    await page.getByRole('tab', { name: 'verify.filter_test', exact: true }).click();
    await expect(page.getByRole('cell', { name: '11', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '12', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
    await run("ALTER TABLE verify.filter_test ADD COLUMN added text DEFAULT 'refreshed';");
    await page.getByRole('tab', { name: 'verify.filter_test', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'refreshed', exact: true })).toHaveCount(2);
    await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
    await editor.press('ControlOrMeta+a');
    await editor.pressSequentially('SELECT count(*) AS verified_users FROM verify.users;');
  });
  await test.step('Migration dry-run rolls back; explicit apply commits', async () => {
    await page.locator('summary').filter({ hasText: /^Query$/ }).click();
    await page.getByRole('button', { name: 'Migration Studio', exact: true }).click();
    await page.getByLabel('Migration SQL').fill('CREATE TABLE verify.migrated (id integer PRIMARY KEY);');
    await expect(page.getByRole('button', { name: 'Apply migration', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Dry run', exact: true }).click();
    await expect(page.getByText(/Dry-run passed and rolled back/)).toBeVisible();
    expect(sql("SELECT to_regclass('verify.migrated') IS NULL")).toBe('t');
    await page.getByRole('button', { name: 'Apply migration', exact: true }).click();
    await expect.poll(() => sql("SELECT to_regclass('verify.migrated') IS NOT NULL")).toBe('t');
  });
  await test.step('Reload restores connection and SQL, resets write access', async () => {
    await page.reload();
    await page.getByRole('tab', { name: 'Query 1', exact: true }).click();
    await expect(page.locator('.cm-content[contenteditable=true]:visible')).toContainText('SELECT count(*)');
    await expect(page.getByRole('button', { name: 'Read Only', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('workbench.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
});

test('saved writable default applies on connect and reload but refresh preserves manual read-only', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New connection', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connection manager' });
  await dialog.getByLabel('Name', { exact: true }).fill('Writable PostgreSQL');
  await dialog.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('Port', { exact: true }).fill('15432');
  await dialog.getByLabel('Database', { exact: true }).fill('tern_verify');
  await dialog.getByLabel('Username', { exact: true }).fill('tern');
  await dialog.getByLabel('Default to read-only').uncheck();
  await dialog.getByRole('button', { name: 'Save & Connect' }).click();
  await expect(page.getByRole('button', { name: '● Writable', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  await page.locator('.cm-content[contenteditable=true]:visible').pressSequentially("DO $$ BEGIN INSERT INTO verify.orders VALUES (3, 1, 7); END $$;");
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(() => sql('SELECT count(*) FROM verify.orders WHERE id=3')).toBe('1');
  await expect(page.getByRole('tab', { name: /Query.*●/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: '● Writable', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '● Writable', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Read Only', exact: true })).toBeVisible();
  const catalog = page.waitForResponse(response => response.url().includes('/api/datasource/schema'));
  await page.getByRole('button', { name: 'Refresh catalog', exact: true }).click();
  await catalog;
  await expect(page.getByRole('button', { name: 'Read Only', exact: true })).toBeVisible();
});
