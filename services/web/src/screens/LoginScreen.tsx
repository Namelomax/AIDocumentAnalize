import { useState, type FormEvent } from 'react';
import { ShieldCheck, Fingerprint, Loader2 } from 'lucide-react';
import Button from '../components/Button';

interface Props {
  onLogin: () => void;
}

type LoginState = 'idle' | 'loading' | 'error';

export default function LoginScreen({ onLogin }: Props) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState<LoginState>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!login.trim() || !password.trim()) {
      setState('error');
      setErrorMsg('Заполните логин и пароль');
      return;
    }
    setState('loading');
    setErrorMsg('');
    window.setTimeout(() => {
      if (login.trim().length < 3 || password.trim().length < 3) {
        setState('error');
        setErrorMsg('Неверный логин или пароль');
        return;
      }
      onLogin();
    }, 700);
  };

  const invalid = state === 'error';

  return (
    <div className="min-h-screen w-screen flex items-center justify-center bg-[#F5F7FA] px-4">
      <div className="w-[400px] bg-white border border-[#E2E8F0] rounded-lg shadow-sm p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-md bg-[#1B4E9B] text-white flex items-center justify-center font-semibold text-[14px]">
            ИИ
          </div>
          <div>
            <div className="text-[16px] font-semibold text-[#0F172A] leading-5">Инспектор ИИ</div>
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide">Мосгосстройнадзор</div>
          </div>
        </div>

        <p className="text-[13px] text-[#475569] leading-5 mb-6">
          Сервис сверки проектной, рабочей и&nbsp;исполнительной документации
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-[#475569]">Логин</span>
            <input
              type="text"
              value={login}
              autoComplete="username"
              autoFocus
              onChange={(e) => { setLogin(e.target.value); if (state === 'error') setState('idle'); }}
              aria-invalid={invalid}
              className={[
                'h-9 px-3 border rounded-md text-[13px] bg-white outline-none',
                invalid
                  ? 'border-[#F04438] focus:border-[#F04438]'
                  : 'border-[#CBD5E1] focus:border-[#1B4E9B]'
              ].join(' ')}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-[#475569]">Пароль</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => { setPassword(e.target.value); if (state === 'error') setState('idle'); }}
              aria-invalid={invalid}
              className={[
                'h-9 px-3 border rounded-md text-[13px] bg-white outline-none',
                invalid
                  ? 'border-[#F04438] focus:border-[#F04438]'
                  : 'border-[#CBD5E1] focus:border-[#1B4E9B]'
              ].join(' ')}
            />
          </label>

          {state === 'error' && (
            <div
              role="alert"
              className="text-[12px] text-[#B42318] bg-[#FEF3F2] border border-[#FECDCA] rounded-md px-3 py-2"
            >
              {errorMsg}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full mt-1"
            disabled={state === 'loading'}
            icon={state === 'loading' ? <Loader2 size={14} className="animate-spin" /> : undefined}
          >
            {state === 'loading' ? 'Вход…' : 'Войти'}
          </Button>
        </form>

        <div className="mt-6 pt-4 border-t border-[#E2E8F0]">
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Функция появится в следующих версиях"
            className="w-full text-[12px] text-[#94A3B8] flex items-center justify-center gap-1.5 cursor-not-allowed"
          >
            <Fingerprint size={14} aria-hidden />
            Вход по электронной подписи
          </button>
        </div>

        <div className="mt-4 flex items-center gap-1.5 text-[11px] text-[#94A3B8] justify-center">
          <ShieldCheck size={12} aria-hidden />
          Защищённое соединение · ЕСИА
        </div>
      </div>
    </div>
  );
}