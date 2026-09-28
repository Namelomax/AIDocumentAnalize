"""Prometheus metrics for the worker.

Customer's ТЗ p.31: "Интеграция с Prometheus для сбора метрик". Counters and
histograms live in this one module, separate from app.main (which only
starts the HTTP exporter) and from the pipeline/LLM client (which record
events), so a test can import and assert on a metric directly without
touching an HTTP server at all - the module-level registry prometheus_client
keeps by default is enough.

Process-level metrics (CPU seconds, RSS, open fds, GC) are not defined here:
prometheus_client registers its own ProcessCollector and GCCollector on
import, before app.main ever calls start_http_server.
"""

from prometheus_client import Counter, Histogram

# One PDF file's extraction, once all retries for it are exhausted
# (app.pipeline._extract_document_pages). "ok" also covers a file that only
# succeeded on a retry - the file's own outcome, not any one attempt's.
files_processed_total = Counter(
    "inspector_files_processed_total",
    "PDF files whose extraction finished, by final outcome",
    ["result"],
)

# Every extraction attempt, including ones that were later retried - the
# ratio against inspector_files_processed_total is how many retries a run
# actually needed.
file_attempts_total = Counter(
    "inspector_file_attempts_total",
    "PDF text-extraction attempts across all files, including retries",
)

# One process.start task, once every in-process retry
# (app.pipeline.process_start) has been exhausted one way or the other.
processes_total = Counter(
    "inspector_processes_total",
    "process.start tasks completed, by final outcome",
    ["result"],
)

# Wall-clock time for one process.start task end to end, success or failure -
# the customer's "время ответа" for the worker side of the pipeline.
process_duration_seconds = Histogram(
    "inspector_process_duration_seconds",
    "Time to process one process.start task, success or failure",
)

# One row per check written by a run, counted only for the three statuses an
# inspector's screen actually shows as a finding (section 9.2/9.5) -
# completeness-only rows (finding_status is null) are not findings and are
# never counted here.
findings_total = Counter(
    "inspector_findings_total",
    "Findings written per run, by finding status",
    ["status"],
)

# Calls to the configured language model (app.llm.provider.ChatProvider).
# "error" covers everything complete_json turns into LlmUnavailable -
# unreachable server, timeout, or a response that was not the JSON shape
# asked for.
llm_requests_total = Counter(
    "inspector_llm_requests_total",
    "Calls to the configured language model, by outcome",
    ["result"],
)

llm_request_duration_seconds = Histogram(
    "inspector_llm_request_duration_seconds",
    "Language model call latency",
)

# Customer's ТЗ: "Инкрементальное обновление протокола (при дозагрузке) — не
# более 1 минуты" - wall-clock time for one process.update task end to end,
# success or failure, in the shape of process_duration_seconds above but
# counted separately: a дозагрузка's own budget is an order of magnitude
# tighter than a fresh run's, and folding the two into one histogram would
# hide whether this specific budget is actually being met.
incremental_update_duration_seconds = Histogram(
    "inspector_incremental_update_duration_seconds",
    "Time to process one process.update (дозагрузка) task, success or failure",
)

# Section 9.5's free-search hypotheses (SEM-ROOM-FN), moved off process.start/
# process.update's own critical path into their own follow-up task
# (app.pipeline.process_hypotheses) so a slow local model never costs the
# matrix protocol's own budget. Counted separately from the two histograms
# above for the same reason incremental_update_duration_seconds is its own
# histogram: this task's budget (none - it runs after the protocol is already
# READY) is not comparable to either of theirs.
hypotheses_duration_seconds = Histogram(
    "inspector_hypotheses_duration_seconds",
    "Time to process one process.hypotheses task, success or failure",
)

# Redis lookups of a PDF's cached parse result, by app.pdf.cache.ParseCache
# (customer's ТЗ p.16, п.5 "Кеширование"). "miss" is a key that simply is not
# there yet; "error" covers both an unreachable Redis and a corrupt entry -
# either way the caller falls back to parsing the file from scratch, so a
# cache is never able to fail a run that would otherwise have succeeded.
parse_cache_total = Counter(
    "inspector_parse_cache_total",
    "PDF parse cache lookups, by outcome",
    ["result"],
)

# One page that carried no text layer (app.pdf.extract's needs_ocr), once
# app.pipeline has finished trying to OCR it. "ok" is a page that got at
# least one recovered line; "low_quality" reached the model but got nothing
# legible back; "unavailable" is OCR_MODEL unset or the model unreachable
# for every strip of the page - all three still let the process finish
# (customer's ТЗ p.16 п.1: a page that cannot be read returns LOW_QUALITY,
# never an invented value), only "ok" hands the explication parser real text.
ocr_pages_total = Counter(
    "inspector_ocr_pages_total",
    "Pages handed to the OCR model, by outcome",
    ["result"],
)

# One HTTP call to the OCR model - one page is usually several of these
# (app.ocr.tiling splits a page into horizontal strips), so this is a call's
# own latency, not a page's total OCR time.
ocr_request_duration_seconds = Histogram(
    "inspector_ocr_request_duration_seconds",
    "OCR model call latency, per strip",
)

# One outcome from app.params.engine.evaluate_all, per parameter, by its own
# modality (scalar_text/doc_presence/drawing_entity/drawing_measure) and
# status - the cheap per-run signal for how much of the 132-parameter matrix
# is actually being answered rather than refused (app.params.scalar's own
# module docstring: precision over recall, so NOT_COMPARABLE/MISSING_EVIDENCE
# are expected, not a bug, and are counted here on the same footing as a
# real CANDIDATE/NEGATIVE_VERIFIED).
param_outcomes_total = Counter(
    "inspector_param_outcomes_total",
    "Matrix parameter outcomes per run, by modality and status",
    ["code_group", "status"],
)
