import { api } from './client';

export interface MockAttachment {
  id: number;
  filename: string;
  contentType: string;
  inline: boolean;
  size: number;
}

export interface MockEmail {
  id: number;
  direction: 'enviado' | 'recibido';
  messageId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  /** ISO: envío o, para los recibidos, el momento de la carga. */
  date: string;
  attachments: MockAttachment[];
}

export interface UploadAttachment {
  filename: string;
  contentType: string;
  /** Imagen embebida en el cuerpo (como el logo de una firma): no cuenta como adjunto. */
  inline: boolean;
  contentBase64: string;
}

export interface UploadEmail {
  from: string;
  subject: string;
  text: string;
  attachments: UploadAttachment[];
}

export async function listMockEmails(): Promise<MockEmail[]> {
  return (await api<{ emails: MockEmail[] }>('GET', '/mock-mailbox')).emails;
}

export async function uploadMockEmail(email: UploadEmail): Promise<void> {
  await api('POST', '/mock-mailbox', email);
}

export const mockAttachmentUrl = (emailId: number, attachmentId: number) =>
  `/api/mock-mailbox/${emailId}/attachments/${attachmentId}`;

/** Contenido de un archivo en base64, sin el prefijo "data:...;base64,". */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}
