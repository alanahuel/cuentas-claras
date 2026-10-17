import { test, expect } from '@playwright/test';
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'] } });
test('private chat, live text, photo, microphone recording and permission revocation', async ({browser})=>{
  const origin='http://127.0.0.1:8000';
  const manager=await browser.newContext({permissions:['microphone']}),customer=await browser.newContext();
  async function register(context,name,type){const r=await context.request.post(origin+'/api/register',{headers:{Origin:origin},data:{name,email:`chat-${type}-${Date.now()}@example.test`,password:'chat-local-test-password',account_type:type}});expect(r.status()).toBe(201);const u=await r.json();return {...u,headers:{Origin:origin,'X-CSRF-Token':u.csrf}};}
  const owner=await register(manager,'Gestor Diego','agency'),client=await register(customer,'Clara Estudio','personal');
  const code=(await (await manager.request.post(origin+'/api/agency/invite',{headers:owner.headers})).json()).code;
  expect((await customer.request.post(origin+'/api/agency/connection',{headers:client.headers,data:{code,accept:true}})).status()).toBe(200);
  const page=await manager.newPage(),other=await customer.newPage(),errors=[];
  for(const p of [page,other])p.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await other.goto('/');
  await page.getByRole('button',{name:'Mensajes',exact:true}).click();
  await page.getByRole('button',{name:/Clara Estudio/}).click();
  await page.getByLabel('Mensaje para Clara Estudio',{exact:true}).fill('Hola Clara, ya he revisado los documentos. ¿Puedes enviarme una foto del ticket?');
  await page.getByRole('button',{name:'Enviar',exact:true}).click();
  await expect(page.getByRole('log')).toContainText('Hola Clara');
  await other.getByRole('button',{name:/^Mensajes/}).click();
  await expect(other.getByRole('button',{name:/Gestor Diego/})).toContainText('1 sin leer');
  await other.getByRole('button',{name:/Gestor Diego/}).click();
  await expect(other.getByRole('log')).toContainText('Hola Clara');
  await other.getByLabel('Mensaje para Gestor Diego',{exact:true}).fill('Sí, te paso la foto ahora.');
  await other.getByRole('button',{name:'Enviar',exact:true}).click();
  await expect(page.getByRole('log')).toContainText('Sí, te paso la foto ahora.',{timeout:8000});
  await other.getByLabel('Adjuntar foto',{exact:true}).setInputFiles('tests/fixtures/photo-invoice.jpg');
  await expect(other.getByAltText('Foto preparada para enviar')).toBeVisible();
  await other.getByRole('button',{name:'Enviar',exact:true}).click();
  const photo=page.getByRole('log').getByRole('img');await expect(photo).toBeVisible({timeout:8000});
  expect(await photo.evaluate(el=>el.complete&&el.naturalWidth>0)).toBeTruthy();
  await page.getByRole('button',{name:'Grabar audio',exact:true}).click();
  await expect(page.getByRole('button',{name:/Detener · 1s/})).toBeVisible({timeout:8000});
  await page.getByRole('button',{name:/Detener ·/}).click();
  await expect(page.getByLabel('Escuchar nota antes de enviar')).toBeVisible();
  await page.getByRole('button',{name:'Enviar',exact:true}).click();
  const audio=other.getByRole('log').locator('audio');await expect(audio).toBeVisible({timeout:8000});
  await audio.evaluate(el=>el.play());
  await expect.poll(()=>audio.evaluate(el=>el.currentTime)).toBeGreaterThan(0);
  await audio.evaluate(el=>el.pause());
  // A failed refresh after a successful send must not report a failed delivery.
  await page.route('**/api/chat/*/messages?after=*', route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Actualización temporalmente interrumpida.'})}));
  await page.getByLabel('Mensaje para Clara Estudio',{exact:true}).fill('Gracias, el ticket se lee bien. Te aviso cuando termine la revisión.');
  await page.getByRole('button',{name:'Enviar',exact:true}).click();
  await expect(other.getByRole('log')).toContainText('el ticket se lee bien',{timeout:8000});
  await expect(page.getByLabel('Mensaje para Clara Estudio',{exact:true})).toHaveValue('');
  await expect(page.getByText('Tu mensaje se conserva para reintentar.',{exact:false})).not.toBeVisible();
  await page.unroute('**/api/chat/*/messages?after=*');
  await expect(page.getByRole('log')).toContainText('el ticket se lee bien',{timeout:8000});
  for(const width of [1440,1236,390]){
    await page.setViewportSize({width,height:950});await page.evaluate(()=>window.scrollTo(0,0));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:`../.impeccable/review/chat-thread-${width}.png`,fullPage:true});
  }
  await page.getByRole('button',{name:'Volver a conversaciones',exact:true}).click();
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'../.impeccable/review/chat-inbox-390.png',fullPage:true});
  await customer.request.delete(origin+`/api/agency/connections/${owner.id}`,{headers:client.headers});
  await expect(page.getByRole('button',{name:/Clara Estudio/})).not.toBeVisible({timeout:8000});
  await expect(other.getByText('Conversación no disponible',{exact:true})).toBeVisible({timeout:8000});
  expect(errors).toEqual([]);await manager.close();await customer.close();
});
