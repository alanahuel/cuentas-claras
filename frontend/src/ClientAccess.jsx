import React, { useEffect, useState } from "react";

export function ClientActivationForm({api,onLogin,onCancel,initialCode=''}) {
  const [code,setCode]=useState(initialCode),[preview,setPreview]=useState(null),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function check(){setBusy(true);setError('');try{setPreview(await api('/client-access',{method:'POST',body:JSON.stringify({code})}));}catch(e){setError(e.message);}finally{setBusy(false);}}
  useEffect(()=>{if(initialCode)check();},[]);
  async function activate(e){e.preventDefault();if(!preview){await check();return;}if(password!==confirmation){setError('Las contraseñas no coinciden.');return;}setBusy(true);setError('');try{
    const user=await api('/client-access',{method:'POST',body:JSON.stringify({code,password})});history.replaceState(null,'',location.pathname);onLogin(user);
  }catch(e){setError(e.message);}finally{setBusy(false);}}
  return <main className="login"><section className="login-story"><div className="brand"><img src="/icon.svg" alt=""/>Cuentas</div><div><h1>Tu gestoría,<br/>más cerca.</h1><p>Comparte documentos y habla con tu gestor desde tu propia cuenta.</p></div></section>
    <section className="login-form"><form onSubmit={activate}><h2>Activa tu acceso de cliente</h2>
      {!preview ? <><p>Introduce la invitación que te ha compartido tu gestoría.</p><label className="field"><span>Código de acceso de cliente</span><input required value={code} onChange={e=>setCode(e.target.value)} autoComplete="off"/></label></> : <>
        <p><strong>{preview.name}</strong> · {preview.agency}</p><p>Accederás con <strong>{preview.email}</strong>.</p>
        <p className="banner">Este acceso depende de tu vinculación con la gestoría. Si termina, se desactiva el acceso y se conserva el expediente. No es una cuenta personal de autónomo.</p>
        <label className="field"><span>Elige tu contraseña</span><input type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={password} onChange={e=>setPassword(e.target.value)}/><small>Al menos 12 caracteres. Tu gestoría no tendrá acceso a ella.</small></label>
        <label className="field"><span>Repite tu contraseña de cliente</span><input type="password" autoComplete="new-password" required value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="button primary" disabled={busy}>{busy?'Comprobando…':preview?'Activar mi acceso':'Comprobar invitación de cliente'}</button>
      <button className="text-button" type="button" disabled={busy} onClick={onCancel}>Volver al inicio de sesión</button>
    </form></section>
  </main>;
}

export function ClientInvitation({invitation}) {
  if(!invitation)return null;
  const link=`${location.origin}/#activar-cliente=${encodeURIComponent(invitation.code)}`;
  return <section className="client-invitation" aria-label="Invitación de acceso del cliente"><h3>Comparte el acceso con el cliente</h3><p>Invitación para <strong>{invitation.email}</strong>. Caduca en 24 horas y solo se puede usar una vez. El cliente elegirá su contraseña. No se envía ningún correo automáticamente.</p>
    <label className="field"><span>Enlace de activación del cliente</span><input readOnly value={link} onFocus={e=>e.target.select()}/></label>
    <label className="field"><span>Código de activación del cliente</span><input readOnly value={invitation.code} onFocus={e=>e.target.select()}/></label>
  </section>;
}
