import { extractTag, postSoap, readMessages } from './soap.js';
import {
  ArcaError,
  CONCEPT_SERVICES,
  DOC_TYPE_CUIT,
  fromArcaAmount,
  fromArcaDate,
  toArcaAmount,
  toArcaDate,
  VOUCHER_TYPE_FACTURA_C,
  type ArcaClient,
  type AuthorizedVoucher,
  type VoucherRequest,
} from './types.js';
import type { AccessTicket } from './wsaa.js';

/** Solo homologación: nunca los endpoints productivos (AGENTS.md). */
export const WSFE_HOMOLOGACION_URL = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx';
const WSFE_NS = 'http://ar.gov.afip.dif.FEV1/';

/** Código de ARCA para "comprobante inexistente" en FECompConsultar. */
const VOUCHER_NOT_FOUND = '602';

export interface WsfeOptions {
  /** CUIT del emisor (ARCA_CUIT). */
  cuit: string;
  getTicket: () => Promise<AccessTicket>;
  fetchImpl?: typeof fetch;
}

/** RF-71, RF-72, RF-77: Factura C contra WSFEv1 de homologación. */
export class WsfeClient implements ArcaClient {
  constructor(private readonly options: WsfeOptions) {}

  async lastAuthorizedNumber(pointOfSale: number): Promise<number> {
    const xml = await this.call(
      'FECompUltimoAutorizado',
      `<ar:PtoVta>${pointOfSale}</ar:PtoVta><ar:CbteTipo>${VOUCHER_TYPE_FACTURA_C}</ar:CbteTipo>`,
    );
    throwOnErrors(xml, 'FECompUltimoAutorizado');
    const number = Number(extractTag(xml, 'CbteNro'));
    if (!Number.isInteger(number) || number < 0) {
      throw new ArcaError('FECompUltimoAutorizado no devolvió un número de comprobante.');
    }
    return number;
  }

  async getVoucher(pointOfSale: number, number: number): Promise<AuthorizedVoucher | null> {
    const xml = await this.call(
      'FECompConsultar',
      '<ar:FeCompConsReq>' +
        `<ar:CbteTipo>${VOUCHER_TYPE_FACTURA_C}</ar:CbteTipo>` +
        `<ar:CbteNro>${number}</ar:CbteNro>` +
        `<ar:PtoVta>${pointOfSale}</ar:PtoVta>` +
        '</ar:FeCompConsReq>',
    );
    const errors = extractTag(xml, 'Errors');
    if (errors && extractTag(errors, 'Code')?.trim() === VOUCHER_NOT_FOUND) return null;
    throwOnErrors(xml, 'FECompConsultar');

    const result = extractTag(xml, 'ResultGet');
    if (!result) return null;
    return {
      pointOfSale,
      number,
      cae: requiredTag(result, 'CodAutorizacion'),
      caeDueDate: fromArcaDate(requiredTag(result, 'FchVto')),
      issueDate: fromArcaDate(requiredTag(result, 'CbteFch')),
      receiverCuit: requiredTag(result, 'DocNro'),
      totalCents: fromArcaAmount(requiredTag(result, 'ImpTotal')),
    };
  }

  async authorize(request: VoucherRequest): Promise<AuthorizedVoucher> {
    const total = toArcaAmount(request.totalCents);
    // Factura C no discrimina IVA: el neto es el total y el IVA es 0.
    const detail =
      `<ar:Concepto>${CONCEPT_SERVICES}</ar:Concepto>` +
      `<ar:DocTipo>${DOC_TYPE_CUIT}</ar:DocTipo>` +
      `<ar:DocNro>${request.receiverCuit}</ar:DocNro>` +
      `<ar:CbteDesde>${request.number}</ar:CbteDesde>` +
      `<ar:CbteHasta>${request.number}</ar:CbteHasta>` +
      `<ar:CbteFch>${toArcaDate(request.issueDate)}</ar:CbteFch>` +
      `<ar:ImpTotal>${total}</ar:ImpTotal>` +
      '<ar:ImpTotConc>0</ar:ImpTotConc>' +
      `<ar:ImpNeto>${total}</ar:ImpNeto>` +
      '<ar:ImpOpEx>0</ar:ImpOpEx>' +
      '<ar:ImpTrib>0</ar:ImpTrib>' +
      '<ar:ImpIVA>0</ar:ImpIVA>' +
      `<ar:FchServDesde>${toArcaDate(request.serviceFrom)}</ar:FchServDesde>` +
      `<ar:FchServHasta>${toArcaDate(request.serviceTo)}</ar:FchServHasta>` +
      `<ar:FchVtoPago>${toArcaDate(request.paymentDueDate)}</ar:FchVtoPago>` +
      '<ar:MonId>PES</ar:MonId>' +
      '<ar:MonCotiz>1</ar:MonCotiz>' +
      `<ar:CondicionIVAReceptorId>${request.receiverIvaCondition}</ar:CondicionIVAReceptorId>`;

    const xml = await this.call(
      'FECAESolicitar',
      '<ar:FeCAEReq>' +
        '<ar:FeCabReq>' +
        `<ar:CantReg>1</ar:CantReg><ar:PtoVta>${request.pointOfSale}</ar:PtoVta>` +
        `<ar:CbteTipo>${VOUCHER_TYPE_FACTURA_C}</ar:CbteTipo>` +
        '</ar:FeCabReq>' +
        `<ar:FeDetReq><ar:FECAEDetRequest>${detail}</ar:FECAEDetRequest></ar:FeDetReq>` +
        '</ar:FeCAEReq>',
    );

    const detailResponse = extractTag(xml, 'FECAEDetResponse') ?? '';
    const result = extractTag(detailResponse, 'Resultado')?.trim();
    const cae = extractTag(detailResponse, 'CAE')?.trim();
    const caeDueDate = extractTag(detailResponse, 'CAEFchVto')?.trim();

    if (result !== 'A' || !cae || !caeDueDate) {
      const reasons = [
        readMessages(extractTag(xml, 'Errors')),
        readMessages(extractTag(detailResponse, 'Observaciones')),
      ].filter(Boolean);
      throw new ArcaError(
        `ARCA rechazó la factura ${request.pointOfSale}-${request.number}` +
          (reasons.length > 0 ? `: ${reasons.join(' · ')}` : '.'),
      );
    }

    return {
      pointOfSale: request.pointOfSale,
      number: request.number,
      cae,
      caeDueDate: fromArcaDate(caeDueDate),
      issueDate: request.issueDate,
      receiverCuit: request.receiverCuit,
      totalCents: request.totalCents,
    };
  }

  private async call(method: string, body: string): Promise<string> {
    const { token, sign } = await this.options.getTicket();
    const auth =
      '<ar:Auth>' +
      `<ar:Token>${token}</ar:Token><ar:Sign>${sign}</ar:Sign><ar:Cuit>${this.options.cuit}</ar:Cuit>` +
      '</ar:Auth>';
    const envelope =
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${WSFE_NS}">` +
      `<soapenv:Header/><soapenv:Body><ar:${method}>${auth}${body}</ar:${method}></soapenv:Body>` +
      '</soapenv:Envelope>';
    return postSoap(WSFE_HOMOLOGACION_URL, `${WSFE_NS}${method}`, envelope, this.options.fetchImpl);
  }
}

function throwOnErrors(xml: string, method: string): void {
  const errors = readMessages(extractTag(xml, 'Errors'));
  if (errors) throw new ArcaError(`ARCA (${method}): ${errors}`);
}

function requiredTag(xml: string, name: string): string {
  const value = extractTag(xml, name)?.trim();
  if (!value) throw new ArcaError(`La respuesta de ARCA no trae ${name}.`);
  return value;
}
