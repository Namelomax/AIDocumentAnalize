import { config } from './config.js';

export const loggerOptions = {
  level: config.logLevel,
  formatters: {
    level: (label: string) => ({ level: label.toUpperCase() }),
    bindings: () => ({ service: 'api' }),
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  messageKey: 'message',
  // ТЗ задаёт точный набор полей, по которым централизованное хранилище
  // разбирает логи. user_id появляется здесь как null до задачи
  // аутентификации, которая подменит его на настоящего пользователя:
  // отсутствующее поле ломает разбор так же, как переименованное.
  mixin: () => ({ user_id: null as string | null }),
};
