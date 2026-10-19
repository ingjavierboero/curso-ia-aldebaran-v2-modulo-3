import type { IncomingAttachment } from './types.js';

/** RF-117: solo imágenes JPEG, PNG, GIF o WebP y PDF. */
const VALID_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);

const TYPES_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/**
 * Tipo del adjunto. Algunos clientes de email mandan los PDF o las imágenes como
 * application/octet-stream: en ese caso se deduce por la extensión del nombre.
 */
export function attachmentType(attachment: Pick<IncomingAttachment, 'filename' | 'contentType'>): string {
  const declared = attachment.contentType.toLowerCase().split(';')[0]!.trim();
  if (declared !== 'application/octet-stream' && declared !== '') return declared === 'image/jpg' ? 'image/jpeg' : declared;
  const extension = attachment.filename.toLowerCase().split('.').pop() ?? '';
  return TYPES_BY_EXTENSION[extension] ?? declared;
}

/**
 * RF-115 a RF-117: adjunto que puede ser un comprobante. Las imágenes embebidas en el
 * cuerpo y los archivos de otros formatos (por ejemplo, .docx) no cuentan.
 */
export function isValidAttachment(attachment: Pick<IncomingAttachment, 'filename' | 'contentType' | 'inline'>): boolean {
  return !attachment.inline && VALID_TYPES.has(attachmentType(attachment));
}
