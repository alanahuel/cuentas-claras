import { test, expect } from '@playwright/test';
test('private assistant conversations, navigation, context and mobile', async ({ page, baseURL }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const r = await page.request.post('/api/register', { headers: { Origin: baseURL }, data: {
    name: 'Prueba conversaciones', email: `conversation-${Date.now()}@example.test`, password: 'solo-pruebas-asistente' } });
  expect(r.status()).toBe(201);
  let remaining = 20, failing = false, count = 0;
  const rows = [];
  await page.route('**/api/assistant**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/assistant') return route.fulfill({ json: { available: true, daily_limit: 20, remaining_today: remaining } });
    if (path === '/api/assistant/conversations') {
      if (method === 'POST') { const row = { id: String(++count), title: 'Nueva conversación', turns: [] }; rows.unshift(row); return route.fulfill({ status: 201, json: row }); }
      return route.fulfill({ json: rows });
    }
    const id = path.split('/')[4], row = rows.find(r => r.id === id);
    if (method === 'DELETE') { rows.splice(rows.indexOf(row), 1); return route.fulfill({ json: { ok: true } }); }
    if (method === 'GET') return route.fulfill({ json: row });
    if (failing) return route.fulfill({ status: 429, json: { detail: 'Has alcanzado tu límite diario.' } });
    const body = route.request().postDataJSON(); expect(body.request_id).toBeTruthy();
    remaining--; row.title = row.turns.length ? row.title : body.question;
    const answer = row.turns.length ? 'Después puedes revisar el gasto y guardarlo.' : 'Pulsa Añadir documento y selecciona Gasto.';
    row.turns.push({ id: row.turns.length + 1, request_id: body.request_id, question: body.question, answer, state: 'completed' });
    await route.fulfill({ json: { answer } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Navegación principal' }).getByRole('button', { name: 'Mensajes', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Ayuda con IA', exact: true }).click();
  await page.getByRole('button', { name: 'Nueva conversación', exact: true }).click();
  await page.getByRole('button', { name: '¿Cómo registro un gasto?', exact: true }).click();
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Pulsa Añadir documento');
  await page.getByLabel('Mensaje al asistente').fill('¿Y después?');
  await page.getByLabel('Mensaje al asistente').press('Enter');
  await expect(page.getByRole('log')).toContainText('Después puedes revisar');
  await expect(page.getByText('18 de 20 preguntas', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar conversación', exact: true }).click();
  await page.getByRole('button', { name: 'Nueva conversación', exact: true }).click();
  await expect(page.getByRole('log')).not.toContainText('¿Y después?');
  await page.getByRole('button', { name: 'Cerrar conversación', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: 'Ayuda con IA', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir conversación: ¿Cómo registro un gasto?', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('¿Y después?');
  await page.screenshot({ path: '../.impeccable/review/conversations-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: '../.impeccable/review/conversations-mobile.png', fullPage: true });
  failing = true;
  await page.getByLabel('Mensaje al asistente').fill('¿Cómo exporto?');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('límite diario');
  await expect(page.getByLabel('Mensaje al asistente')).toHaveValue('¿Cómo exporto?');
  await page.getByRole('button', { name: 'Cerrar conversación', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Nueva conversación', exact: true })).toBeVisible();
  await page.screenshot({ path: '../.impeccable/review/conversations-list-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Abrir conversación: ¿Cómo registro un gasto?', exact: true }).click();
  await page.getByRole('button', { name: 'Eliminar conversación', exact: true }).click();
  await page.getByRole('button', { name: 'Eliminar definitivamente', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Abrir conversación: ¿Cómo registro un gasto?', exact: true })).toHaveCount(0);
  await page.route('**/api/workspaces', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.managers = [{ id: 'test-manager', name: 'Gestoría de prueba', enabled: 1, archived: 0 }];
    await route.fulfill({ json: data });
  });
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Navegación principal' }).getByRole('button', { name: 'Mensajes', exact: true })).toHaveCount(1);
  expect(errors).toEqual([]);
});
