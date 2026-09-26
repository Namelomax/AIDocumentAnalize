import { config } from './config.js';
import { currentUser } from './auth/context.js';

export const loggerOptions = {
  level: config.logLevel,
  formatters: {
    level: (label: string) => ({ level: label.toUpperCase() }),
    bindings: () => ({ service: 'api' }),
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  messageKey: 'message',
  // Section 13 of the specification fixes the log fields a central store
  // parses. user_id is always present, null before login, so a missing field
  // never breaks that parsing.
  mixin: () => ({ user_id: currentUser()?.id ?? null }),
};
