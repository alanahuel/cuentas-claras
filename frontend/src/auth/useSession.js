import { useEffect, useRef, useState } from "react";
import { api, setSessionToken } from "../lib/api";
import { clearDrafts } from "../offline";

/** Owns session restoration, authentication, expiry and logout; App owns workspace data. */
export function useSession({ onAuthenticated, onEnded }) {
  const [user, setUser] = useState(null);
  const [actor, setActor] = useState(null);
  const [loading, setLoading] = useState(true);
  const callbacks = useRef({ onAuthenticated, onEnded });
  callbacks.current = { onAuthenticated, onEnded };
  const generation = useRef(0);
  const signIn = (account) => {
    ++generation.current;
    setSessionToken(account.csrf);
    setActor(account);
    setUser(account);
    callbacks.current.onAuthenticated();
  };
  const endSession = () => {
    ++generation.current;
    setSessionToken("");
    setActor(null);
    setUser(null);
    callbacks.current.onEnded();
  };
  useEffect(() => {
    let active = true;
    const requestGeneration = generation.current;
    api("/me").then(account => {
      if (active && requestGeneration === generation.current) signIn(account);
    }).catch(() => {}).finally(() => { if (active) setLoading(false); });
    window.addEventListener("session-ended", endSession);
    return () => { active = false; window.removeEventListener("session-ended", endSession); };
  }, []);
  const signOut = async (userId) => {
    await api("/logout", { method: "POST" });
    try { await clearDrafts(userId); }
    finally { endSession(); }
  };
  return { user, setUser, actor, loading, signIn, signOut, endSession };
}
