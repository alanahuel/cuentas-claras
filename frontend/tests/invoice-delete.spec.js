import { test, expect } from '@playwright/test';

test('delete confirmed income and expense with confirmation and updated totals', async ({ page, baseURL }) => {
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  const registration=await page.request.post('/api/register',{headers:{Origin:baseURL},data:{name:'Prueba eliminación',email:`delete-${Date.now()}@example.test`,password:'solo-pruebas-eliminacion'}});
  expect(registration.status()).toBe(201);
  const {csrf}=await registration.json();const headers={Origin:baseURL,'X-CSRF-Token':csrf};
  for (const kind of ['income','expense']) {
    const response=await page.request.post('/api/invoices',{headers,data:{kind,status:'confirmed',date:'2026-09-10',number:`DELETE-${kind}`,party:`Example ${kind}`,nif:'B12345678',lines:[{base:kind==='income'?10000:5000,vat_rate:21}],request_id:`delete-test-${kind}`}});
    expect(response.ok()).toBeTruthy();
  }
  await page.goto('/');await page.getByLabel('Ejercicio',{exact:true}).fill('2026');await page.getByLabel('Trimestre',{exact:true}).selectOption('3');
  await page.getByRole('button',{name:'Facturas y gastos',exact:true}).click();
  for (const [kind,label,width] of [['income','Eliminar factura',1440],['expense','Eliminar gasto',390]]) {
    await page.setViewportSize({width,height:900});
    await page.getByRole('button',{name:`Example ${kind}`,exact:true}).click();
    await expect(page.getByRole('button',{name:label,exact:true})).toBeEnabled();
    page.once('dialog',dialog=>dialog.dismiss());
    await page.getByRole('button',{name:label,exact:true}).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button',{name:label,exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:`../.impeccable/review/delete-${kind}.png`});
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:label,exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button',{name:`Example ${kind}`,exact:true})).toHaveCount(0);
  }
  expect(await (await page.request.get('/api/invoices')).json()).toEqual([]);
  expect((await (await page.request.get('/api/summary?year=2026&quarter=3')).json()).vat_balance).toBe(0);
  expect(errors).toEqual([]);
});
