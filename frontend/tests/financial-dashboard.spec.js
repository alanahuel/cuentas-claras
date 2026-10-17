import { test, expect } from '@playwright/test';

test('annual dashboard, payment records and contextual fiscal guidance', async ({ page, baseURL }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const response = await page.request.post('/api/register', {
    headers: { Origin: baseURL },
    data: { name: 'Prueba de evolución', email: `evolution-${Date.now()}@example.test`, password: 'solo-pruebas-dashboard' },
  });
  expect(response.status()).toBe(201);
  const { csrf } = await response.json();
  const headers = { Origin: baseURL, 'X-CSRF-Token': csrf };
  for (const [i, month, kind, base, status] of [[1, 1, 'income', 100000, 'confirmed'], [2, 1, 'expense', 40000, 'confirmed'], [3, 2, 'expense', 20000, 'confirmed'], [4, 9, 'income', 150000, 'confirmed'], [5, 9, 'income', 900000, 'draft']]) {
    const result = await page.request.post('/api/invoices', { headers, data: { kind, status, date: `2026-${String(month).padStart(2, '0')}-10`, number: `CHART-${i}`, party: 'Ejemplo sintético', nif: 'B12345678', lines: [{ base, vat_rate: 21, irpf_deduct: 50 }], request_id: `evolution-invoice-${i}` } });
    expect(result.ok()).toBeTruthy();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Ejercicio', { exact: true }).fill('2026');
  await page.getByLabel('Trimestre', { exact: true }).selectOption('1');
  const totals = page.getByRole('region', { name: 'Resumen económico' });
  await expect(totals).toContainText('1000,00');
  await expect(totals).toContainText('600,00');
  await expect(totals).toContainText('400,00');
  await expect(totals).toContainText('Sin registrar');
  await page.getByRole('button', { name: 'Año completo', exact: true }).click();
  await expect(totals).toContainText('2500,00');
  await expect(totals).toContainText('1900,00');
  await page.getByRole('button', { name: 'Beneficio', exact: true }).click();
  await page.getByRole('button', { name: 'Febrero de 2026', exact: true }).click();
  await expect(page.locator('.month-detail')).toContainText('-200,00');
  await page.getByRole('button', { name: 'Registrar pagos', exact: true }).click();
  await page.getByLabel('Mes del pago').selectOption('1');
  await page.getByLabel('IVA pagado (€)', { exact: true }).fill('210');
  await page.getByLabel('IRPF pagado (€)', { exact: true }).fill('150');
  await page.getByLabel('Otros impuestos pagados (€)', { exact: true }).fill('40');
  await page.getByRole('button', { name: 'Guardar pagos del mes' }).click();
  await expect(page.getByRole('status')).toContainText('Pagos de enero guardados.');
  await expect(totals).toContainText('400,00');
  await expect(totals).toContainText('1 de 12 meses registrados');
  await page.reload();
  await page.getByLabel('Trimestre', { exact: true }).selectOption('1');
  await expect(totals).toContainText('1 de 3 meses registrados');
  await page.getByRole('button', { name: 'Año completo', exact: true }).click();
  await page.getByRole('button', { name: 'Ingresos y gastos', exact: true }).click();
  await page.screenshot({ path: '../.impeccable/review/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Tu año, mes a mes' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: '../.impeccable/review/dashboard-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Impuestos', exact: true }).click();
  await page.getByRole('button', { name: 'Enero de 2026', exact: true }).click();
  await expect(page.locator('.month-detail')).toContainText('400,00');
  await page.getByRole('button', { name: 'Febrero de 2026', exact: true }).click();
  await expect(page.locator('.month-detail')).toContainText('Sin registrar');
  await page.getByText('Ver todos los importes del año', { exact: true }).click();
  await expect(page.locator('.chart-table tbody tr')).toHaveCount(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: 'Completar perfil fiscal', exact: true }).click();
  await expect(page.getByRole('heading', { name: '¿No sabes qué elegir?' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Régimen de IRPF', exact: true }).selectOption('direct_simplified');
  await expect(page.getByText(/incluye automáticamente los gastos de difícil justificación/)).toBeVisible();
  await page.getByText('¿Cómo distingo normal, simplificada y módulos?', { exact: true }).click();
  await expect(page.getByText(/No basta con facturar poco/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Régimen de IVA', exact: true }).selectOption('general');
  await page.getByRole('combobox', { name: 'Obligación de presentar Modelo 130', exact: true }).selectOption('yes');
  await expect(page.locator('.fiscal-readiness')).toContainText('Disponible · directa simplificada, apartado I');
  await page.getByText('¿Cuándo puede aplicarse la excepción del 70 %?', { exact: true }).click();
  await expect(page.getByText(/7.000 € de ingresos sujetos a retención/)).toBeVisible();
  await page.screenshot({ path: '../.impeccable/review/profile-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '../.impeccable/review/profile-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Guardar perfil', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Perfil actualizado');
  await expect(page.getByRole('combobox', { name: 'Régimen de IRPF', exact: true })).toHaveValue('direct_simplified');
  expect(errors).toEqual([]);
});
