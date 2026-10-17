import {test, expect} from '@playwright/test';

test('invalid extraction leaves manual fields intact and allows retry', async ({page, baseURL}) => {
  const result = await page.request.post('/api/register', {headers:{Origin:baseURL}, data:{name:'Invalid extraction',email:`invalid-${Date.now()}@example.test`,password:'synthetic-extraction-test'}});
  expect(result.status()).toBe(201);
  await page.route('**/api/documents?kind=expense', route => route.fulfill({json:{id:'synthetic',fields:{number:'OVERWRITE',lines:[{base:'not-money',vat_rate:21}]}}}));
  await page.goto('/');
  await page.getByRole('button',{name:'Añadir documento',exact:true}).click();
  await page.getByLabel('Número de factura',{exact:true}).fill('MY-CORRECTION');
  await page.locator('input[type=file]').last().setInputFiles('tests/fixtures/autofill-invoice.pdf');
  await expect(page.locator('.analysis-status')).toContainText('No se ha completado');
  await expect(page.getByRole('alert')).toContainText('Tus cambios se conservan');
  await expect(page.getByLabel('Número de factura',{exact:true})).toHaveValue('MY-CORRECTION');
  await expect(page.locator('input[type=file]').last()).toBeEnabled();
  await expect(page.getByRole('button',{name:'Guardar borrador',exact:true})).toBeEnabled();
});
