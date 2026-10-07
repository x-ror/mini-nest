import {
  BadRequestException,
  mixin,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type Type,
} from "@nestjs/common";

/** An uploaded file in the shape Multer's memory storage produces. */
export interface UploadedFileData {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}
interface UploadRequest {
  body?: unknown;
  file?: UploadedFileData;
  files?: UploadedFileData[] | Record<string, UploadedFileData[]>;
}

// Moves the files of one top-level field out of the parsed multipart body.
async function takeFiles(
  body: Record<string, unknown>,
  field: string,
): Promise<UploadedFileData[]> {
  const value = body[field];
  const entries = Array.isArray(value) ? value : [value];
  const files = entries.filter((entry): entry is File => entry instanceof File);
  if (!files.length) return [];
  const rest = entries.filter((entry) => !(entry instanceof File));
  if (rest.length) body[field] = rest.length === 1 ? rest[0] : rest;
  else delete body[field];
  return Promise.all(
    files.map(async (file) => ({
      fieldname: field,
      originalname: file.name,
      encoding: "7bit",
      mimetype: file.type.split(";")[0]!,
      size: file.size,
      buffer: Buffer.from(await file.arrayBuffer()),
    })),
  );
}

function fileFields(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((field) =>
    ([] as unknown[]).concat(body[field]).some((entry) => entry instanceof File),
  );
}

function uploadInterceptor(
  collect: (request: UploadRequest, body: Record<string, unknown>) => Promise<void>,
): Type<NestInterceptor> {
  return mixin(
    class {
      async intercept(context: ExecutionContext, next: CallHandler) {
        const request = context.switchToHttp().getRequest<UploadRequest>();
        const body = request.body;
        if (body !== null && typeof body === "object")
          await collect(request, body as Record<string, unknown>);
        return next.handle();
      }
    },
  );
}

function reject(body: Record<string, unknown>, allowed: string[]): void {
  const unexpected = fileFields(body).find((field) => !allowed.includes(field));
  if (unexpected !== undefined) throw new BadRequestException(`Unexpected field - ${unexpected}`);
}

/** Like Multer's `FileInterceptor`: one file from `fieldName` for `@UploadedFile()`. */
export function FileInterceptor(fieldName: string): Type<NestInterceptor> {
  return uploadInterceptor(async (request, body) => {
    reject(body, [fieldName]);
    const files = await takeFiles(body, fieldName);
    if (files.length > 1) throw new BadRequestException(`Unexpected field - ${fieldName}`);
    request.file = files[0];
  });
}

/** Like Multer's `FilesInterceptor`: every file from `fieldName` for `@UploadedFiles()`. */
export function FilesInterceptor(fieldName: string, maxCount = Infinity): Type<NestInterceptor> {
  return uploadInterceptor(async (request, body) => {
    reject(body, [fieldName]);
    const files = await takeFiles(body, fieldName);
    if (files.length > maxCount) throw new BadRequestException(`Too many files - ${fieldName}`);
    request.files = files;
  });
}

/** Like Multer's `FileFieldsInterceptor`: `@UploadedFiles()` gets files grouped by field. */
export function FileFieldsInterceptor(
  fields: { name: string; maxCount?: number }[],
): Type<NestInterceptor> {
  return uploadInterceptor(async (request, body) => {
    reject(
      body,
      fields.map((field) => field.name),
    );
    const grouped: Record<string, UploadedFileData[]> = {};
    for (const { name, maxCount = Infinity } of fields) {
      const files = await takeFiles(body, name);
      if (files.length > maxCount) throw new BadRequestException(`Too many files - ${name}`);
      if (files.length) grouped[name] = files;
    }
    request.files = grouped;
  });
}

/** Like Multer's `AnyFilesInterceptor`: every uploaded file, whatever its field. */
export function AnyFilesInterceptor(): Type<NestInterceptor> {
  return uploadInterceptor(async (request, body) => {
    const files: UploadedFileData[] = [];
    for (const field of fileFields(body)) files.push(...(await takeFiles(body, field)));
    request.files = files;
  });
}
