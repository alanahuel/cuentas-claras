import {test, expect} from '@playwright/test';

test('team invitations, assigned portfolio and revoked access', async ({browser}) => {
  const origin = 'http://127.0.0.1:8000';
  const manager = await browser.newContext(), employee = await browser.newContext();
  const password = 'team-local-browser-password';
  async function register(context,name,type) {
    const email = `${type}-${Date.now()}@example.test`;
    const response = await context.request.post(origin+'/api/register', {headers:{Origin:origin},data:{name,email,password,account_type:type}});
    expect(response.status()).toBe(201);
    const user = await response.json();
    return {...user,email,headers:{Origin:origin,'X-CSRF-Token':user.csrf}};
  }
  const owner = await register(manager,'Gestoría del equipo','agency');
  const member = await register(employee,'Marta Gestora','personal');
  const clientIds = [];
  for (const name of ['Taller de ejemplo','Estudio privado']) {
    const response = await manager.request.post(origin+'/api/agency/clients',{headers:owner.headers,data:{name}});
    expect(response.status()).toBe(200);clientIds.push((await response.json()).id);
  }
  const page = await manager.newPage(), other = await employee.newPage();
  const errors = [];
  for(const p of [page,other]) p.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByRole('button',{name:'Clientes y equipo',exact:true}).click();await page.getByRole('button',{name:'Equipo',exact:true}).click();
  await page.getByText('Invitar a un colaborador',{exact:true}).click();
  await page.getByLabel('Correo del colaborador',{exact:true}).fill(member.email);
  await page.getByRole('button',{name:'Generar invitación de equipo',exact:true}).click();
  const code = await page.getByLabel('Código de invitación de equipo',{exact:true}).inputValue();
  await other.goto('/');await other.getByRole('button',{name:'Opciones de mi cuenta',exact:true}).click();await other.getByRole('button',{name:'Gestoría y accesos',exact:true}).click();await other.getByRole('button',{name:'Equipo',exact:true}).click();
  await other.getByLabel('Código para unirme al equipo',{exact:true}).fill(code);await other.getByRole('button',{name:'Comprobar invitación de equipo',exact:true}).click();
  await expect(other.getByRole('heading',{name:'Gestoría del equipo',exact:true})).toBeVisible();
  await other.getByRole('button',{name:'Aceptar y unirme al equipo',exact:true}).click();
  await expect(other.getByText('Te has unido al equipo. La gestoría ya puede asignarte clientes.',{exact:true})).toBeVisible();
  await other.getByRole('button',{name:'Cartera de clientes',exact:true}).click();
  await expect(other.getByRole('heading',{name:'Aún no tienes clientes asignados',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Actualizar equipo',exact:true}).click();
  await page.getByRole('button',{name:'Asignar clientes a Marta Gestora',exact:true}).click();
  await page.getByRole('checkbox',{name:'Taller de ejemplo',exact:true}).check();
  await page.getByRole('button',{name:'Guardar asignaciones',exact:true}).click();
  await expect(page.getByText('Asignaciones guardadas. Los permisos ya están actualizados.',{exact:true})).toBeVisible();
  await other.getByRole('button',{name:'Actualizar cartera',exact:true}).click();
  await expect(other.getByRole('button',{name:'Abrir Taller de ejemplo',exact:true})).toBeVisible();
  await expect(other.getByRole('button',{name:'Abrir Estudio privado',exact:true})).not.toBeVisible();
  await expect(other.getByRole('button',{name:'Archivar',exact:true})).not.toBeVisible();
  await expect(other.getByText('Añadir cliente',{exact:true})).not.toBeVisible();
  await page.getByRole('button',{name:'Asignar clientes a Marta Gestora',exact:true}).click();
  // Collapse the invitation so the screenshots show no live invitation code.
  await page.getByText('Invitar a un colaborador',{exact:true}).click();
  for(const width of [1440,1236,390]) {
    await page.setViewportSize({width,height:950});await page.evaluate(()=>window.scrollTo(0,0));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:`../.impeccable/review/team-admin-${width}.png`,fullPage:true});
    await other.setViewportSize({width,height:900});await other.evaluate(()=>window.scrollTo(0,0));
    expect(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await other.screenshot({path:`../.impeccable/review/team-member-${width}.png`,fullPage:true});
  }
  await page.getByRole('button',{name:'Cancelar',exact:true}).click();
  await other.getByRole('button',{name:'Abrir Taller de ejemplo',exact:true}).click();
  await other.getByRole('button',{name:'Añadir documento',exact:true}).click();
  await other.getByLabel('Número de factura',{exact:true}).fill('TEAM-001');
  await other.getByLabel('Proveedor',{exact:true}).fill('Proveedor del equipo');
  await other.getByLabel('NIF del tercero',{exact:true}).fill('B12345678');
  await other.getByLabel('He comprobado el original, los importes y su deducibilidad.').check();
  await other.getByRole('button',{name:'Aprobar y contabilizar',exact:true}).click();
  await expect(other.getByRole('dialog')).not.toBeVisible();
  const invoices = await (await manager.request.get(origin+'/api/invoices',{headers:{'X-Workspace-Id':clientIds[0]}})).json();
  const history = await (await manager.request.get(origin+`/api/invoices/${invoices[0].id}/reviews`,{headers:{'X-Workspace-Id':clientIds[0]}})).json();
  expect(history[0].actor_name).toBe('Marta Gestora');
  page.on('dialog',d=>d.accept());
  await page.getByRole('button',{name:'Retirar a Marta Gestora',exact:true}).click();
  await expect(page.getByText('Colaborador retirado. Sus asignaciones se han eliminado.',{exact:true})).toBeVisible();
  expect((await employee.request.get(origin+'/api/invoices',{headers:{'X-Workspace-Id':clientIds[0]}})).status()).toBe(403);
  await other.reload();await expect(other.getByRole('button',{name:'Clientes y equipo',exact:true})).not.toBeVisible();
  expect(errors).toEqual([]);await manager.close();await employee.close();
});
