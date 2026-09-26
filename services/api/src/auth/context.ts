import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserRole } from '@prisma/client';

export interface RequestUser {
  id: string;
  login: string;
  role: UserRole;
}

// The logger reads the user from here rather than from a child logger. A
// child binding cannot replace a field the root logger already emits: pino
// writes both, and the line carries "user_id" twice, null first - which is
// the value a log collector keeps.
const storage = new AsyncLocalStorage<{ user?: RequestUser }>();

export function enterRequestContext(): void {
  storage.enterWith({});
}

export function setCurrentUser(user: RequestUser): void {
  const store = storage.getStore();
  if (store) store.user = user;
}

export function currentUser(): RequestUser | undefined {
  return storage.getStore()?.user;
}
