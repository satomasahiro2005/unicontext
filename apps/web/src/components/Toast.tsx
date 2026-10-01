import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type ToastKind = 'ok' | 'error';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi>({ success: () => undefined, error: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    setItems((list) => [...list.slice(-3), { id, kind, message }]);
    window.setTimeout(
      () => setItems((list) => list.filter((t) => t.id !== id)),
      kind === 'error' ? 8000 : 4000,
    );
  }, []);

  const api = useMemo<ToastApi>(
    () => ({ success: (m) => push('ok', m), error: (m) => push('error', m) }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <p key={t.id} className={`toast toast-${t.kind}`}>
            <span aria-hidden="true">{t.kind === 'ok' ? '✓' : '!'}</span> {t.message}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
