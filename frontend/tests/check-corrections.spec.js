import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('correct individually and together; delete one or all unattached files without duplicate panels', async ({ page, baseURL }) => {
  test.skip(!process.env.INVOICE_CHECKS_FIXTURE, 'Requires backend/tests/serve_invoice_checks.py (synthetic provider).');
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const registered = await page.request.post('/api/register', { headers: { Origin: baseURL }, data: { name: 'Correcciones sintéticas', email: `correct-${Date.now()}@example.test`, password: 'solo-pruebas-correcciones' } });
  expect(registered.status()).toBe(201);
  const { csrf } = await registered.json();
  const headers = { Origin: baseURL, 'X-CSRF-Token': csrf };
  const pdf = readFileSync('tests/fixtures/autofill-invoice.pdf');
  const upload = async (name, suffix) => {
    const response = await page.request.post('/api/documents', { headers, multipart: { file: { name, mimeType: 'application/pdf', buffer: Buffer.concat([pdf, Buffer.from(`\n%${suffix}`)]) } } });
    expect(response.ok()).toBeTruthy(); return (await response.json()).id;
  };
  const original = await upload('original.pdf', 'original');
  const ids = [];
  for (const number of ['CORRECT-A', 'CORRECT-B', 'CORRECT-C']) {
    const response = await page.request.post('/api/invoices', { headers, data: { kind: 'income', status: 'confirmed', date: '2026-10-01', number, party: 'Example', nif: 'B12345678', lines: [{ base: 10000, vat_rate: 21 }], withholding: 0, document_id: original, request_id: `request-${number}` } });
    expect(response.ok()).toBeTruthy(); ids.push((await response.json()).id);
  }
  for (const name of ['uno.pdf', 'dos.pdf', 'tres.pdf']) await upload(name, name);
  await page.goto('/');
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Facturas y gastos', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Documentos sin registrar', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: 'Vista general', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Documentos sin registrar', exact: true })).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Facturas y gastos', exact: true }).click();
  await page.getByRole('button', { name: 'Comprobar todas las facturas', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Corregir todas las discrepancias (3)', exact: true })).toBeEnabled();
  await expect(page.locator('.check-results')).not.toBeVisible();
  await expect(page.locator('.check-help')).not.toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '../.impeccable/review/corrections-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: '../.impeccable/review/corrections-mobile.png', fullPage: true });
  await page.locator('.check-details > summary').click();
  await page.locator('.check-results > li').filter({ has: page.getByRole('heading', { name: /^CORRECT-A/ }) }).getByRole('button', { name: 'Corregir discrepancias', exact: true }).click();
  await expect(page.locator('.invoice-checks [role=status]')).toContainText('1 registros corregidos');
  await expect(page.getByRole('button', { name: 'Corregir todas las discrepancias (2)', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Corregir todas las discrepancias (2)', exact: true }).click();
  await expect(page.locator('.invoice-checks [role=status]')).toContainText('2 registros corregidos');
  const records = await (await page.request.get('/api/invoices')).json();
  expect(records.every(i => i.date === '2026-09-30' && i.version === 2)).toBeTruthy();
  expect((await (await page.request.get('/api/summary?year=2026&quarter=3')).json()).output_vat).toBe(6300);
  await page.getByRole('button', { name: 'Eliminar uno.pdf', exact: true }).click();
  await expect(page.locator('.unattached-entry').filter({ hasText: 'uno.pdf' }).getByRole('group')).toBeVisible();
  await page.getByRole('button', { name: 'Eliminar archivo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Eliminar uno.pdf', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Eliminar todos (2)', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirmar eliminación de todos los documentos sin registrar' })).toContainText('2 documentos');
  await page.getByRole('button', { name: 'Eliminar todos los documentos', exact: true }).click();
  await expect(page.locator('.unattached')).toHaveCount(0);
  expect(await (await page.request.get('/api/documents')).json()).toEqual([]);
  expect((await page.request.get(`/api/documents/${original}`)).status()).toBe(200);
  expect((await (await page.request.get('/api/invoices')).json()).length).toBe(3);
  expect(errors).toEqual([]);
});
