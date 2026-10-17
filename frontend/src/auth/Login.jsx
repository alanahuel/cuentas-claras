import { ArrowRight, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { ClientActivationForm } from "../ClientAccess";
import { api } from "../lib/api";
import { Button, Field, ErrorBox } from "../components/ui";
export default function Login({ onLogin, online }) {
  const initialClientCode = new URLSearchParams(window.location.hash.slice(1)).get("activar-cliente") || "";
  const [activatingClient, setActivatingClient] = useState(!!initialClientCode);
  const [accountType, setAccountType] = useState("personal");
  const [registering, setRegistering] = useState(
      new URLSearchParams(window.location.search).get("registro") === "1",
    ),
    [name, setName] = useState(""),
    [confirmation, setConfirmation] = useState("");
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (registering && password !== confirmation) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onLogin(
        await api(registering ? "/register" : "/login", {
          method: "POST",
          body: JSON.stringify(
            registering
              ? { name, email, password, account_type: accountType }
              : { email, password },
          ),
        }),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (activatingClient) return <ClientActivationForm api={api} onLogin={onLogin} initialCode={initialClientCode} onCancel={() => { history.replaceState(null,"",location.pathname); setActivatingClient(false); }} />;
  return (
    <main className="login">
      <section className="login-story">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          Cuentas
        </div>
        <div>
          <h1>
            Menos papeles.
            <br />
            Más claridad.
          </h1>
          <p>
            Facturas, gastos y tu trimestre en un mismo lugar. Un espacio propio
            para llevar tu actividad al día.
          </p>
          <div className="login-rule" />
          <span>Tu actividad. Tus documentos. Tu servidor.</span>
        </div>
        <small>Gestión para autónomos · Salamanca</small>
      </section>
      <section className="login-form">
        <form onSubmit={submit}>
          <h2>{registering ? "Crea tu cuenta" : "Entra en tus cuentas"}</h2>
          <p>
            {registering
              ? "Empieza con un espacio propio para tus facturas y gastos."
              : "Accede a tu espacio personal."}
          </p>
          {registering && (
            <Field label="Tu nombre">
              <input
                required
                minLength="2"
                maxLength="100"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          )}
          {registering && (
            <Field label="Tipo de cuenta">
              <select
                value={accountType}
                onChange={(e) => setAccountType(e.target.value)}
              >
                <option value="personal">Autónomo · mi actividad</option>
                <option value="agency">Gestoría · varios clientes</option>
              </select>
            </Field>
          )}
          <Field label="Correo electrónico">
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Contraseña">
            <input
              type="password"
              autoComplete={registering ? "new-password" : "current-password"}
              minLength={registering ? 12 : undefined}
              maxLength="256"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {registering && (
            <>
              <small className="password-hint">
                Usa una contraseña de al menos 12 caracteres.
              </small>
              <Field label="Repite la contraseña">
                <input
                  required
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </Field>
            </>
          )}
          <ErrorBox message={error} />
          {!online && (
            <p className="banner">Necesitas conexión para iniciar sesión.</p>
          )}
          <Button
            className="primary"
            disabled={busy || !online}
            icon={busy ? LoaderCircle : ArrowRight}
          >
            {busy
              ? registering
                ? "Creando cuenta…"
                : "Entrando…"
              : registering
                ? "Crear cuenta"
                : "Entrar"}
          </Button>
          <div className="auth-switch">
            <span>
              {registering ? "¿Ya tienes cuenta?" : "¿Aún no tienes cuenta?"}
            </span>
            <button
              type="button"
              className={
                registering ? "text-button" : "button secondary register-button"
              }
              disabled={busy}
              onClick={() => {
                setRegistering(!registering);
                setError("");
                setPassword("");
                setConfirmation("");
              }}
            >
              {registering ? "Iniciar sesión" : "Crear una cuenta"}
            </button>
          </div>
          <button className="text-button" type="button" onClick={() => setActivatingClient(true)}>Activar acceso de cliente</button>
          <p className="login-help">
            {registering
              ? "Tus registros estarán separados de los de otras cuentas. El correo se utiliza para identificar tu acceso; no se envía un mensaje de verificación."
              : "Si necesitas recuperar el acceso, contacta con el administrador del servidor."}
          </p>
        </form>
      </section>
    </main>
  );
}
