// Phase-1 package validation (format, magic bytes, size, one-registry-only),
// shared by POST /documents/upload (routes/documents.ts, a brand new
// process) and POST /processes/:id/documents (routes/processDocuments.ts,
// customer's ТЗ "Дозагрузка файлов" into an existing one). Nothing here
// touches Prisma or storage - both routes read the same multipart stream
// through this one module so the rules (and their Russian wording) can never
// drift apart between the two entry points.
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';

export const ALLOWED = new Map([
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/xml', '.xml'],
  ['text/xml', '.xml'],
]);

// A registry is not a package document: it describes the package rather than
// being part of it, so its formats live in a set of their own instead of
// being folded into ALLOWED.
export const MANIFEST_TYPES = new Map([
  ['text/csv', '.csv'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/json', '.json'],
]);

const MAGIC: Record<string, Buffer> = {
  '.pdf': Buffer.from('%PDF'),
  // Both are zip containers underneath, so they carry the same signature. A
  // registry of random bytes is caught here with a reason the inspector can
  // read, rather than surfacing much later as a parse warning in worker logs.
  '.docx': Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  '.xlsx': Buffer.from([0x50, 0x4b, 0x03, 0x04]),
};

function looksCorrupted(extension: string, body: Buffer): boolean {
  if (extension === '.xml') {
    // XML has no magic number, but a readable document always opens with a
    // tag once the BOM and leading whitespace are gone. Without this, a file
    // of random bytes declared as XML would be stored as a valid registry.
    const text = body.toString('utf8').replace(/^﻿/, '').trimStart();
    return !text.startsWith('<');
  }
  const magic = MAGIC[extension];
  if (!magic) return false;
  return !body.subarray(0, magic.length).equals(magic);
}

export interface PendingFile {
  fileName: string;
  body: Buffer;
  mimeType: string;
  isManifest: boolean;
}

// The names the interface's upload dialog offers the inspector; kept here
// because the server is the only place both the formats and the limits below
// are known precisely, and a rejection message quotes both.
export const SUPPORTED_FORMATS = ['PDF', 'DOCX', 'XML'];
export const REGISTRY_FORMATS = ['CSV', 'XLSX', 'JSON'];

// Megabytes as the interface shows them; the limits themselves stay in bytes.
export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} МБ`;
}

export type RejectionReason =
  | 'UNSUPPORTED_FORMAT' | 'FILE_TOO_LARGE' | 'CORRUPTED_FILE' | 'DUPLICATE'
  | 'MULTIPLE_MANIFESTS' | 'INTERNAL_ERROR';

// Section 9.1's error handling table: an unsupported format names the formats
// that are supported, an oversized file names the limit it crossed, and a
// corrupted file tells the inspector to try again rather than leaving them to
// guess why nothing was stored.
export function rejection(fileName: string, reason: RejectionReason) {
  switch (reason) {
    case 'UNSUPPORTED_FORMAT':
      return {
        file_name: fileName, reason,
        supported_formats: SUPPORTED_FORMATS, registry_formats: REGISTRY_FORMATS,
        message: `Неподдерживаемый формат. Документы: ${SUPPORTED_FORMATS.join(', ')}; реестр: ${REGISTRY_FORMATS.join(', ')}`,
      };
    case 'FILE_TOO_LARGE':
      return {
        file_name: fileName, reason, max_bytes: config.maxFileBytes,
        message: `Файл больше допустимого размера ${megabytes(config.maxFileBytes)}`,
      };
    case 'CORRUPTED_FILE':
      return { file_name: fileName, reason, message: 'Файл повреждён или не читается. Загрузите файл повторно' };
    case 'DUPLICATE':
      return { file_name: fileName, reason, message: 'Такой файл уже загружен по этому объекту' };
    case 'MULTIPLE_MANIFESTS':
      return { file_name: fileName, reason, message: 'В пакете может быть только один реестр' };
    default:
      return { file_name: fileName, reason, message: 'Файл не сохранён из-за внутренней ошибки. Повторите загрузку' };
  }
}

export type Rejection = ReturnType<typeof rejection>;

export interface ValidatedPackage {
  pending: PendingFile[];
  rejected: Rejection[];
  packageBytes: number;
}

// Phase 1: read and validate every part of the multipart body without
// storing anything. EVERY part counts towards the package total, rejected
// ones included - otherwise the limit is walked past with files of an
// unsupported type. The caller decides what "too large" means for the whole
// package (a fresh upload and a дозагрузка both cap it at
// config.maxPackageBytes today, but neither route hardcodes the other's
// business rules here).
export async function validatePackage(request: FastifyRequest): Promise<ValidatedPackage> {
  const pending: PendingFile[] = [];
  const rejected: Rejection[] = [];
  let packageBytes = 0;
  let manifestSeen = false;

  for await (const part of request.parts()) {
    if (part.type !== 'file') continue;

    const body = await part.toBuffer();
    packageBytes += body.length;

    const isManifest = MANIFEST_TYPES.has(part.mimetype);
    const extension = isManifest ? MANIFEST_TYPES.get(part.mimetype) : ALLOWED.get(part.mimetype);
    if (!extension) {
      rejected.push(rejection(part.filename, 'UNSUPPORTED_FORMAT'));
      continue;
    }
    // Two registries contradict each other and nothing here can pick the
    // right one, so only the first in order is even considered - later
    // ones are rejected outright, without spending a validity check on them.
    if (isManifest) {
      if (manifestSeen) {
        rejected.push(rejection(part.filename, 'MULTIPLE_MANIFESTS'));
        continue;
      }
      manifestSeen = true;
    }
    if (body.length > config.maxFileBytes) {
      rejected.push(rejection(part.filename, 'FILE_TOO_LARGE'));
      continue;
    }
    if (looksCorrupted(extension, body)) {
      rejected.push(rejection(part.filename, 'CORRUPTED_FILE'));
      continue;
    }
    pending.push({ fileName: part.filename, body, mimeType: part.mimetype, isManifest });
  }

  return { pending, rejected, packageBytes };
}
