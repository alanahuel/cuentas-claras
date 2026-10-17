import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
export function Button({ children, icon: Icon, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon }) {
  return (
    <button className={"button " + className} {...props}>
      {Icon && <Icon size={18} />} {children}
    </button>
  );
}
export function Field({ label, children, hint }: {label: string; children: ReactNode; hint?: string}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function ErrorBox({ message }: {message: string}) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}
