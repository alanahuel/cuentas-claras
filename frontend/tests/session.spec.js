import {test, expect} from '@playwright/test';

test('session restores after reload, failed logout preserves access, and expiry clears the editor', async ({page, baseURL}) => {
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  const result = await page.request.post('/api/register', {headers:{Origin:baseURL}, data:{name:'Session test', email:`session-${Date.now()}@example.test`, password:'synthetic-session-test'}});
  expect(result.status()).toBe(201);
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Tu trimestre, en orden.'})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading',{name:'Tu trimestre, en orden.'})).toBeVisible();
  await page.route('**/api/logout', route => route.fulfill({status:503, json:{detail:'Synthetic outage'}}));
  await page.getByRole('button',{name:'Opciones de mi cuenta'}).click();
  await page.getByRole('button',{name:'Cerrar sesión',exact:true}).click();
  await expect(page.getByText('Synthetic outage')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Tu trimestre, en orden.'})).toBeVisible();
  await page.route('**/api/review-policy', route => route.fulfill({status:401,json:{detail:'Session expired'}}));
  await page.getByRole('button',{name:'Añadir documento',exact:true}).click();
  await expect(page.getByLabel('Correo electrónico',{exact:true})).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Opciones de mi cuenta'})).toHaveCount(0);
  expect(errors).toEqual([]);
});
