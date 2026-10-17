import { test, expect } from '@playwright/test';

test('submit, request corrections, approve and switch agency back to personal', async ({ browser }) => {
  const manager = await browser.newContext(), customer = await browser.newContext();
  const origin = 'http://127.0.0.1:8000';
  const password = 'workflow-local-test-password';
  const register = async (context, name, type) => {
    const response = await context.request.post(origin + '/api/register', {
      headers: { Origin: origin },
      data: { name, email: `workflow-${type}-${Date.now()}@example.test`, password, account_type: type },
    });
    expect(response.status()).toBe(201);
    const user = await response.json();
    return { Origin: origin, 'X-CSRF-Token': user.csrf };
  };
  const mh = await register(manager, 'Asesoría de prueba', 'agency');
  const ch = await register(customer, 'Cliente de revisión', 'personal');
  const invitation = await manager.request.post(origin + '/api/agency/invite', { headers: mh });
  expect((await customer.request.post(origin + '/api/agency/connection', { headers: ch, data: { code: (await invitation.json()).code, accept: true } })).status()).toBe(200);
  const page = await customer.newPage(), advisor = await manager.newPage();
  const openClients = async () => {
    const target = advisor.getByRole('button', { name: 'Clientes y equipo', exact: true });
    if (!(await target.isVisible())) await advisor.getByRole('button', { name: 'Mesa de gestoría', exact: true }).click();
    await target.click();
  };
  const errors = [];
  for (const p of [page, advisor]) p.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Añadir documento', exact: true }).click();
  await page.getByLabel('Número de factura', { exact: true }).fill('REV-2025-01');
  await page.getByLabel('Fecha', { exact: true }).fill('2025-12-15');
  await page.getByLabel('Proveedor', { exact: true }).fill('Proveedor para revisar');
  await page.getByLabel('NIF del tercero', { exact: true }).fill('B12345678');
  await page.getByLabel('Base imponible (€)', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Enviar a gestoría', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await advisor.goto('/');
  await openClients();
  await advisor.getByRole('button', { name: 'Revisar pendientes de Cliente de revisión', exact: true }).click();
  await expect(advisor.getByRole('button', { name: 'Proveedor para revisar', exact: true })).toBeVisible();
  await advisor.getByRole('button', { name: 'Enviados 1', exact: true }).click();
  await advisor.getByRole('button', { name: 'Proveedor para revisar', exact: true }).click();
  await advisor.getByRole('button', { name: 'Pedir cambios al cliente', exact: true }).click();
  await advisor.getByLabel('Qué debe corregir el cliente', { exact: true }).fill('El NIF no coincide con el original. Indica B87654321.');
  await advisor.setViewportSize({ width: 1440, height: 1000 });
  await advisor.locator('.document-review').scrollIntoViewIfNeeded();
  await advisor.screenshot({ path: '../.impeccable/review/review-editor-desktop.png' });
  await advisor.setViewportSize({ width: 390, height: 844 });
  await advisor.locator('.request-changes').scrollIntoViewIfNeeded();
  await advisor.screenshot({ path: '../.impeccable/review/review-editor-mobile.png' });
  await advisor.getByRole('button', { name: 'Enviar solicitud de cambios', exact: true }).click();
  await expect(advisor.getByRole('dialog')).not.toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Ver cambios solicitados', exact: true }).click();
  await page.getByRole('button', { name: 'Con cambios 1', exact: true }).click();
  await page.getByRole('button', { name: 'Proveedor para revisar', exact: true }).click();
  await expect(page.getByText('El NIF no coincide con el original. Indica B87654321.', { exact: true }).first()).toBeVisible();
  await page.getByLabel('NIF del tercero', { exact: true }).fill('B87654321');
  await page.getByRole('button', { name: 'Enviar a gestoría', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await openClients();
  await advisor.getByRole('button', { name: 'Revisar pendientes de Cliente de revisión', exact: true }).click();
  for (const width of [1440, 1236, 390]) {
    await advisor.setViewportSize({ width, height: 900 });
    await advisor.evaluate(() => window.scrollTo(0, 0));
    expect(await advisor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await advisor.screenshot({ path: `../.impeccable/review/review-queue-${width}.png`, fullPage: true });
  }
  await advisor.getByRole('button', { name: 'Proveedor para revisar', exact: true }).click();
  await advisor.getByText('Historial de revisión (3)', { exact: true }).click();
  await expect(advisor.getByText('El NIF no coincide con el original. Indica B87654321.', { exact: true })).toBeVisible();
  await advisor.getByLabel('He comprobado el original, los importes y su deducibilidad.').check();
  await advisor.getByRole('button', { name: 'Aprobar y contabilizar', exact: true }).click();
  await expect(advisor.getByRole('dialog')).not.toBeVisible();
  await expect(advisor.getByText('No hay documentos en este estado.', { exact: true })).toBeVisible();
  const records = await (await customer.request.get(origin + '/api/invoices')).json();
  expect(records[0].review_state).toBe('approved');
  expect(records[0].status).toBe('confirmed');
  // Switching while working for a client must return to the owner's own activity.
  await openClients();
  await advisor.getByRole('button', { name: 'Ajustes e historial', exact: true }).click();
  await advisor.getByText('Volver a cuenta de autónomo', { exact: true }).click();
  await expect(advisor.locator('.toast')).not.toBeVisible({timeout:8000});
  for (const width of [1440, 390]) {
    await advisor.setViewportSize({ width, height: 900 });
    await advisor.evaluate(() => window.scrollTo(0, 0));
    await advisor.screenshot({ path: `../.impeccable/review/agency-mode-${width}.png`, fullPage: true });
  }
  await advisor.getByRole('button', { name: 'Cambiar a autónomo', exact: true }).click();
  await expect(advisor.getByRole('button', { name: 'Reactivar gestoría', exact: true })).toBeVisible();
  await expect(advisor.getByRole('combobox', { name: 'Cliente activo', exact: true })).not.toBeVisible();
  await expect(advisor.getByRole('button', { name: 'Clientes y equipo', exact: true })).not.toBeVisible();
  await advisor.getByRole('button', { name: 'Reactivar gestoría', exact: true }).click();
  await expect(advisor.getByRole('button', { name: 'Abrir Cliente de revisión', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await manager.close();
  await customer.close();
});
