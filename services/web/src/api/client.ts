// The token layer (Plan 7, Task 4): every authenticated request goes through
// api()/apiBlob()/uploadPackage() here, so a 401 from anywhere in the app can
// drop the session and hand control back to the login screen in one place,
// per the Global Constraint "любой 401 любого запроса возвращает на экран
// входа". nginx proxies /api to the api service (services/web/nginx.conf), so
// every path below is relative — the browser never talks to a second origin.

export interface SessionUser {
  id: string;
  login: string;
  fullName: string;
  role: string;
}

export interface Session {
  token: string;
  user: SessionUser;
}

const TOKEN_KEY = 'inspector.token';
const USER_KEY = 'inspector.user';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// sessionStorage, not localStorage: closing the tab ends the session (Global
// Constraints of Plan 7 — "закрытие вкладки — выход").
export function getSession(): Session | null {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const rawUser = sessionStorage.getItem(USER_KEY);
  if (!token || !rawUser) return null;
  try {
    return { token, user: JSON.parse(rawUser) as SessionUser };
  } catch {
    // A corrupted entry is as good as no session at all.
    clearSession();
    return null;
  }
}

export function setSession(session: Session): void {
  sessionStorage.setItem(TOKEN_KEY, session.token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(session.user));
}

export function clearSession(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

// App.tsx subscribes once, so it can fall back to the login screen the
// moment any request anywhere in the app comes back 401 — not only the one
// that happened to trigger it.
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function handleUnauthorized(): void {
  clearSession();
  for (const listener of unauthorizedListeners) listener();
}

interface LoginResponseBody {
  token: string;
  user: { id: string; login: string; full_name: string; role: string };
}

export async function login(loginName: string, password: string): Promise<Session> {
  const response = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw new ApiError(401, 'Неверный логин или пароль', 'INVALID_CREDENTIALS');
    }
    throw await readError(response);
  }
  const body = (await response.json()) as LoginResponseBody;
  const session: Session = {
    token: body.token,
    user: {
      id: body.user.id,
      login: body.user.login,
      fullName: body.user.full_name,
      role: body.user.role,
    },
  };
  setSession(session);
  return session;
}

// A readable fallback for server errors that carry only a machine code.
// Routes that already speak Russian to the inspector (uploads, section 9.1)
// set `message` themselves, and that always wins over this map.
const ERROR_MESSAGES: Record<string, string> = {
  VALIDATION_FAILED: 'Запрос составлен неверно',
  UNAUTHORIZED: 'Требуется вход в систему',
  FORBIDDEN: 'Недостаточно прав для этого действия',
};

async function readError(response: Response): Promise<ApiError> {
  let body: { error?: string; message?: string } = {};
  try {
    body = await response.json();
  } catch {
    // No JSON body — fall through to the generic message below.
  }
  const message = body.message
    ?? (body.error && ERROR_MESSAGES[body.error])
    ?? `Ошибка сервера (${response.status})`;
  return new ApiError(response.status, message, body.error);
}

function authHeaders(): HeadersInit {
  const session = getSession();
  return session ? { Authorization: `Bearer ${session.token}` } : {};
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
      ...init.headers,
    },
  });
  if (response.status === 401) {
    handleUnauthorized();
    throw new ApiError(401, 'Сессия истекла, войдите снова', 'UNAUTHORIZED');
  }
  if (!response.ok) throw await readError(response);
  // 202 (process start) and 204 carry a body or none depending on the route;
  // reading as text first and parsing only if non-empty covers both without
  // special-casing status codes here.
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function apiBlob(path: string): Promise<Blob> {
  const response = await fetch(path, { headers: authHeaders() });
  if (response.status === 401) {
    handleUnauthorized();
    throw new ApiError(401, 'Сессия истекла, войдите снова', 'UNAUTHORIZED');
  }
  if (!response.ok) throw await readError(response);
  return response.blob();
}

export interface UploadResult {
  process_id: string;
  accepted: Array<{ file_id: string; file_name: string; sha256: string }>;
  rejected: Array<{ file_name: string; reason: string; message: string }>;
}

// XMLHttpRequest, not fetch: it is the only one of the two that reports
// upload progress, needed for the package-size indicator on the upload
// screen while a large package is in flight.
export function uploadPackage(
  objectId: string,
  files: File[],
  onProgress?: (loaded: number, total: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1/documents/upload?object_id=${encodeURIComponent(objectId)}`);
    const session = getSession();
    if (session) xhr.setRequestHeader('Authorization', `Bearer ${session.token}`);

    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) onProgress(event.loaded, event.total);
    };

    xhr.onload = () => {
      if (xhr.status === 401) {
        handleUnauthorized();
        reject(new ApiError(401, 'Сессия истекла, войдите снова', 'UNAUTHORIZED'));
        return;
      }
      let body: unknown = {};
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        // Falls through with an empty body; the status check below still
        // reports something useful to the caller.
      }
      // 201: at least one file was stored. 422: the whole package was
      // rejected, but documents.ts still answers with the same
      // { accepted, rejected } shape — both are results to read, not just
      // the 201 case.
      if (xhr.status === 201 || xhr.status === 422) {
        resolve(body as UploadResult);
        return;
      }
      const errorBody = body as { error?: string; message?: string };
      reject(new ApiError(
        xhr.status,
        errorBody.message ?? `Ошибка загрузки (${xhr.status})`,
        errorBody.error,
      ));
    };

    xhr.onerror = () => reject(new ApiError(0, 'Не удалось связаться с сервером'));

    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    xhr.send(form);
  });
}
