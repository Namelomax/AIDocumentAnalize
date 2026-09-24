import { config } from './config.js';

export const loggerOptions = {
  level: config.logLevel,
  formatters: {
    level: (label: string) => ({ level: label.toUpperCase() }),
    bindings: () => ({ service: 'api' }),
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  messageKey: 'message',
};
