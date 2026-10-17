import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

test('automatic AI autofill, classification, cached reopening and delete unregistered originals',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let uploadCalls=0,prepareCalls=0,saved;
  await page.route('**/api/document-analysis',route=>route.fulfill({json:{available:true,provider:'OpenAI'}}));
  await page.route('**/api/documents?kind=expense',async route=>{
    uploadCalls++;
    const response=await page.request.post(route.request().url(),{headers:{Origin:route.request().headers()['origin'],'X-CSRF-Token':route.request().headers()['x-csrf-token']},multipart:{file:{name:'autofill-invoice.pdf',mimeType:'application/pdf',buffer:readFileSync('tests/fixtures/autofill-invoice.pdf')}}});
    expect(response.status()).toBe(200);const data=await response.json();
    saved={...data,ai_error:null,fields:{...data.fields,date:'2026-09-04',number:'IA-123'},classification:{document_type:'invoice',issuer_country:'ES',is_spanish:true,evidence:'Emisor con dirección en Madrid, España.'},engine:'OpenAI · lectura con IA',warnings:[],cached:false};
    await route.fulfill({json:saved});
  });
  await page.route('**/api/documents/*/prepare?kind=expense',route=>{
    prepareCalls++;return route.fulfill({json:{...saved,cached:true}});
  });
  await page.goto('/?registro=1');
  await page.getByLabel('Tu nombre',{exact:true}).fill('Prueba lectura');
  await page.getByLabel('Correo electrónico',{exact:true}).fill(`autofill-${Date.now()}@example.test`);
  await page.getByLabel('Contraseña',{exact:true}).fill('registration-local-test');
  await page.getByLabel('Repite la contraseña',{exact:true}).fill('registration-local-test');
  await page.getByRole('button',{name:'Crear cuenta',exact:true}).click();
  await page.getByRole('button',{name:'Añadir documento',exact:true}).click();
  await page.getByLabel('Número de factura',{exact:true}).fill('MI-REFERENCIA');
  await page.locator('input[type=file]').last().setInputFiles('tests/fixtures/autofill-invoice.pdf');
  await expect(page.getByLabel('Proveedor',{exact:true})).toHaveValue('Servicios Ejemplo SL');
  await expect(page.getByLabel('Fecha',{exact:true})).toHaveValue('2026-09-04');
  await expect(page.getByLabel('Número de factura',{exact:true})).toHaveValue('MI-REFERENCIA');
  await expect(page.getByLabel('Base imponible (€)',{exact:true})).toHaveCount(2);
  await expect(page.getByText('País del emisor: España',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Leer con IA',exact:true})).toHaveCount(0);
  expect(uploadCalls).toBe(1);
  await page.getByLabel('Ingreso',{exact:true}).check();
  await expect(page.getByLabel('Cliente',{exact:true})).toHaveValue('Cliente Ejemplo SL');
  await page.getByLabel('Cliente',{exact:true}).fill('Cliente corregido');
  await page.getByLabel('Base imponible (€)',{exact:true}).first().fill('120.00');
  await page.locator('.extraction-review summary').click();
  await page.getByRole('button',{name:'Aplicar propuesta: Número de factura',exact:true}).click();
  await expect(page.getByLabel('Número de factura',{exact:true})).toHaveValue('IA-123');
  for (const [width,height] of [[1440,1000],[390,844]]) {
    await page.setViewportSize({width,height});
    await page.locator('.document-classification').scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:`../.impeccable/review/auto-reading-${width}.png`,fullPage:false});
  }
  page.on('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'Cerrar revisión',exact:true}).click();
  await page.getByRole('button',{name:'Facturas y gastos',exact:true}).click();
  await page.getByRole('button',{name:'autofill-invoice.pdf',exact:true}).click();
  await expect(page.getByLabel('Número de factura',{exact:true})).toHaveValue('IA-123');
  expect(prepareCalls).toBe(1);
  await page.getByRole('button',{name:'Cerrar revisión',exact:true}).click();
  for (const [width,height] of [[1440,1000],[390,844]]) {
    await page.setViewportSize({width,height});
    await page.locator('.unattached').scrollIntoViewIfNeeded();
    await page.screenshot({path:`../.impeccable/review/unattached-delete-${width}.png`,fullPage:true});
  }
  await page.getByRole('button',{name:'Eliminar autofill-invoice.pdf',exact:true}).click();
  await page.getByRole('button',{name:'Cancelar',exact:true}).click();
  await expect(page.getByRole('button',{name:'autofill-invoice.pdf',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Eliminar autofill-invoice.pdf',exact:true}).click();
  await page.getByRole('button',{name:'Eliminar archivo',exact:true}).click();
  await expect(page.getByRole('button',{name:'autofill-invoice.pdf',exact:true})).toHaveCount(0);
  await page.reload();
  expect(await (await page.request.get('/api/documents')).json()).toEqual([]);
  expect(errors).toEqual([]);
});
