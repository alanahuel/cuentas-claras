export const money = (value: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(
    (value || 0) / 100,
  );
export const decimal = (value: number) => (value / 100).toFixed(2);
export const cents = (value: string | number) => {
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n)) throw new Error("Introduce un importe válido.");
  return Math.round(n * 100);
};
export const today = () => new Date().toLocaleDateString("sv-SE");
