import { test, expect } from "@playwright/test";
const login = async (page, email) => {
  await page.goto("/");
  await page.getByLabel("Correo electrónico").fill(email + "@example.test");
  await page
    .getByLabel("Contraseña", { exact: true })
    .fill("solo-pruebas-locales");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Tu trimestre, en orden." }),
  ).toBeVisible();
};
test("desktop and mobile screenshots, private registry and offline draft", async ({
  page,
  context,
}) => {
  // Match the synthetic September fixtures independently of the execution date.
  await page.clock.setFixedTime(new Date("2026-09-25T12:00:00Z"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, "demo");
  await expect(
    page.getByText("Estudio de ejemplo", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../.impeccable/review/desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "../.impeccable/review/mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page
    .getByRole("button", { name: "Resumen fiscal", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "IVA · Modelo 303" }),
  ).toBeVisible();
  await page.screenshot({
    path: "../.impeccable/review/tax-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Opciones de mi cuenta" }).click();
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await login(page, "test");
  await expect(
    page.getByText("Estudio de ejemplo", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Añadir documento", exact: true })
    .click();
  await page
    .getByLabel("Número de factura", { exact: true })
    .fill("E2E-" + Date.now());
  await page
    .getByLabel("Proveedor", { exact: true })
    .fill("Proveedor de prueba");
  await page.getByLabel("NIF del tercero").fill("B12345678");
  await page.getByLabel("Base imponible (€)", { exact: true }).fill("100");
  await page.getByLabel("He comprobado el original").check();
  await page.screenshot({
    path: "../.impeccable/review/editor-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Confirmar y registrar" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByText("Proveedor de prueba", { exact: true }),
  ).toBeVisible();
  await context.setOffline(true);
  await page
    .getByRole("button", { name: "Añadir documento", exact: true })
    .click();
  await page
    .getByLabel("Proveedor", { exact: true })
    .fill("Borrador sin conexión");
  await page
    .getByRole("button", { name: "Guardar borrador", exact: true })
    .click();
  await expect(
    page.getByText("1 borrador(es) guardados en este dispositivo."),
  ).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Sincronizar", exact: true }).click();
  await expect(
    page.getByText("1 borrador(es) guardados en este dispositivo."),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Facturas y gastos", exact: true })
    .click();
  await expect(
    page.getByText("Borrador sin conexión", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
