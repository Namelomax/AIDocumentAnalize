# Мониторинг: Prometheus, Grafana, алертинг

Реализует пункт таблицы ТЗ (`Задание/10. Мосстройнадзор.pdf`, стр. 31):
«Интеграция с Prometheus для сбора метрик и Grafana для визуализации
дашбордов» и «Алертинг: настройка алертов при превышении пороговых значений
метрик».

Поднимается вместе со всем стендом одной командой `docker compose up` —
отдельного шага не требуется.

## Что собирается

- **api** (`services/api/src/metrics.ts`) отдаёт `GET /metrics` на порту
  3000: стандартные метрики процесса (CPU, память), гистограмму
  `http_request_duration_seconds` (по методу, шаблону маршрута и коду
  ответа) и счётчики `inspector_verdicts_total`,
  `inspector_composite_splits_total`, `inspector_finalizations_total`.
  Маршрут не проксируется веб-контейнером (`services/web/nginx.conf`
  форвардит только `/api/`) и не требует токена.
- **worker** (`services/worker/app/metrics.py`) поднимает отдельный HTTP-
  сервер на порту 9100 (переменная `METRICS_PORT`) со счётчиками
  `inspector_files_processed_total`, `inspector_file_attempts_total`,
  `inspector_processes_total`, `inspector_findings_total`,
  `inspector_llm_requests_total` и гистограммами
  `inspector_process_duration_seconds`,
  `inspector_llm_request_duration_seconds`, плюс стандартные метрики
  процесса.
- **prometheus** (`deploy/monitoring/prometheus.yml`) опрашивает оба сервиса
  и сам себя каждые 15 секунд. UI — `http://localhost:9090`.
- **grafana** (`deploy/monitoring/grafana`) поднимается с уже
  подключённым источником данных Prometheus и готовым дашбордом
  «Инспектор ИИ — эксплуатация» — ничего донастраивать вручную не нужно.
  UI — `http://localhost:3001`, логин `admin`, пароль — переменная
  `GRAFANA_ADMIN_PASSWORD` (по умолчанию `admin`). Анонимный доступ
  выключен.

## Алерты

`deploy/monitoring/alert-rules.yml`, видны в Prometheus
(`http://localhost:9090/alerts` и `GET /api/v1/rules`):

| Алерт | Условие | Смысл |
|---|---|---|
| `HighCpu` | `rate(process_cpu_seconds_total[1m]) > 0.8` в течение 2 минут | загрузка CPU сервиса выше 80% — пример из ТЗ |
| `SlowResponses` | p95 `http_request_duration_seconds` > 0.5 с в течение 5 минут, по маршруту | время ответа API выше 500 мс — пример из ТЗ |
| `ProcessingFailures` | рост `inspector_processes_total{result="failed"}` или `inspector_files_processed_total{result="failed"}` за 15 минут | обработка пакета/файла завершилась ошибкой после всех повторов (ТЗ, стр. 17) |
| `TargetDown` | `up == 0` в течение 1 минуты | api, worker или сам Prometheus не отвечают на сбор метрик |

## Почему без Alertmanager

Стенд офлайн и не имеет доступа во внешнюю сеть (см. комментарии к
`LLM_BASE_URL` в `docker-compose.yml` и общие ограничения проверочного
стенда). Доставка по почте и в Telegram, которую называет ТЗ, требует
исходящего сетевого доступа к SMTP-серверу или к Telegram Bot API — того,
чего у стенда нет и не может быть по условиям задания. Поэтому здесь
осознанно нет Alertmanager и получателей: сработавшие алерты видны прямо в
интерфейсе Prometheus и на дашборде Grafana, а не приходят кому-то в
почту.

Там, где сеть есть (боевое окружение, среда с доступом к SMTP/Telegram),
Alertmanager подключается штатно:

1. Добавить сервис `alertmanager` (образ `prom/alertmanager`) в
   `docker-compose.yml` со своим конфигом (например,
   `deploy/monitoring/alertmanager.yml`), где в `receivers` указаны
   SMTP-параметры (`email_configs`) и/или Telegram-бот
   (`telegram_configs`: `bot_token`, `chat_id`).
2. В `deploy/monitoring/prometheus.yml` добавить блок
   `alerting.alertmanagers.static_configs`, указывающий на этот сервис.
3. Правила алертов (`deploy/monitoring/alert-rules.yml`) менять не нужно —
   Prometheus начнёт пересылать в Alertmanager те же самые алерты, которые
   раньше были видны только в его собственном UI.
