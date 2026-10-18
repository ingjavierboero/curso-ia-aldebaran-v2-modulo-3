import QRCode from 'qrcode';
import { DOC_TYPE_CUIT } from '../arca/types.js';

/** Verificador de comprobantes de ARCA al que apunta el QR (RG 4892). */
export const QR_BASE_URL = 'https://www.afip.gob.ar/fe/qr/';

export interface QrData {
  /** YYYY-MM-DD */
  issueDate: string;
  issuerCuit: string;
  pointOfSale: number;
  voucherType: number;
  number: number;
  totalCents: number;
  receiverCuit: string;
  cae: string;
}

/** RG 4892: URL del verificador con los datos del comprobante en JSON y base64. */
export function qrUrl(data: QrData): string {
  const payload = {
    ver: 1,
    fecha: data.issueDate,
    cuit: Number(data.issuerCuit),
    ptoVta: data.pointOfSale,
    tipoCmp: data.voucherType,
    nroCmp: data.number,
    importe: data.totalCents / 100,
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: DOC_TYPE_CUIT,
    nroDocRec: Number(data.receiverCuit),
    tipoCodAut: 'E', // E = CAE
    codAut: Number(data.cae),
  };
  return `${QR_BASE_URL}?p=${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

/**
 * PNG del QR. Se genera en alta resolución porque el QR tiene ~69×69 módulos y se
 * dibuja a 80 pt: con un PNG chico quedaría ilegible.
 */
export function qrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, { type: 'png', width: 600, margin: 1 });
}
