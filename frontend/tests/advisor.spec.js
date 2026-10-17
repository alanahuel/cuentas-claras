import { test, expect } from '@playwright/test';

test('advisor desk, client dossier and a request answered by its actual owner', async ({ browser }) => {
  const origin = 'http://127.0.0.1:8000';
  const manager = await browser.newContext(), customer = await browser.newContext();
  async function register(context, name, type) {
    const response = await context.request.post(origin+'/api/register', {headers:{Origin:origin},data:{name,email:`desk-${type}-${Date.now()}@example.test`,password:'desk-local-test-password',account_type:type}});
    expect(response.status()).toBe(201);
    const user = await response.json();
    return {...user, headers:{Origin:origin,'X-CSRF-Token':user.csrf}};
  }
  const owner = await register(manager, 'Asesoría Norte', 'agency');
  const client = await register(customer, 'Lucía Martín', 'personal');
  const invitation = await (await manager.request.post(origin+'/api/agency/invite',{headers:owner.headers})).json();
  expect((await customer.request.post(origin+'/api/agency/connection',{headers:client.headers,data:{code:invitation.code,accept:true}})).status()).toBe(200);
  const submitted = await customer.request.post(origin+'/api/invoices',{headers:client.headers,data:{kind:'expense',status:'draft',date:'2026-09-15',number:'SUM-2026-09',party:'Suministros del estudio',nif:'B12345678',lines:[{base:12000,vat_rate:21}],withholding:0,request_id:crypto.randomUUID(),review_action:'submit'}});
  expect(submitted.status()).toBe(200);
  const page = await manager.newPage(), other = await customer.newPage();
  const errors = [];
  for (const p of [page,other]) p.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Mesa de gestoría',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Revisar SUM-2026-09 de Lucía Martín',exact:true})).toBeVisible();
  await expect(page.getByText('Tu reserva para impuestos',{exact:true})).not.toBeVisible();
  async function capture(name) {
    await expect(page.locator(".toast")).not.toBeVisible({timeout:8000});
    for(const width of [1440,1236,390]) {
      await page.setViewportSize({width,height:950});await page.evaluate(()=>window.scrollTo(0,0));
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
      await page.screenshot({path:`../.impeccable/review/advisor-${name}-${width}.png`,fullPage:true});
    }
  }
  await capture('desk');
  await page.getByRole('button',{name:'Revisar SUM-2026-09 de Lucía Martín',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('He comprobado el original, los importes y su deducibilidad.').check();
  await page.getByRole('button',{name:'Aprobar y contabilizar',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('heading',{name:'Expediente de Lucía Martín',exact:true})).toBeVisible();
  await expect(page.getByText('Tu reserva para impuestos',{exact:true})).not.toBeVisible();
  await expect(page.locator('.advisor-context')).toContainText('Gestor: Asesoría Norte');
  await capture('dossier');
  await page.getByRole('button',{name:'Ver solicitudes',exact:true}).click();
  await page.getByText('Pedir documentación o información',{exact:true}).click();
  await page.getByLabel('Asunto',{exact:true}).fill('Factura del alquiler de septiembre');
  await page.getByLabel('Qué necesitas del cliente',{exact:true}).fill('Necesito la factura del local para revisar el trimestre. Puedes subirla y confirmarlo aquí.');
  await page.getByRole('button',{name:'Crear solicitud',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Factura del alquiler de septiembre',exact:true})).toBeVisible();
  await other.goto('/');
  await other.getByRole('button',{name:'Responder a la gestoría',exact:true}).click();
  await other.getByLabel('Respuesta a «Factura del alquiler de septiembre»',{exact:true}).fill('He solicitado el duplicado al arrendador. Lo tendré mañana.');
  await other.getByRole('button',{name:'Enviar respuesta',exact:true}).click();
  await expect(other.getByText('Respuesta por revisar',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Mesa de gestoría',exact:true}).click();
  await page.getByRole('button',{name:'Respuestas 1',exact:true}).click();
  await page.getByRole('button',{name:'Abrir expediente',exact:true}).click();
  await expect(page.getByText('He solicitado el duplicado al arrendador. Lo tendré mañana.',{exact:true})).toBeVisible();
  await capture('requests');
  await page.getByRole('button',{name:'Marcar como resuelta',exact:true}).click();
  await expect(page.getByText('Resuelta',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Reabrir solicitud',exact:true}).click();
  await expect(page.getByText('Esperando al cliente',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Mi actividad personal',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Tu trimestre, en orden.',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Ir a la gestoría',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Mesa de gestoría',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
  await manager.close();await customer.close();
});
