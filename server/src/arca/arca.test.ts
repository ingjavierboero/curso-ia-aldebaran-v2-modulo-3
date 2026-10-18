import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import forge from 'node-forge';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { openDatabase, type DatabaseHandle } from '../db/index.js';
import { arcaAccessTickets } from '../db/schema.js';
import { createArcaClient } from './index.js';
import { addDays, MockArcaClient } from './mock.js';
import { ARCA_TIMEOUT_MS } from './soap.js';
import { ArcaError, fromArcaAmount, toArcaAmount, type VoucherRequest } from './types.js';
import { buildTra, getAccessTicket, signTra, WSAA_HOMOLOGACION_URL } from './wsaa.js';
import { WSFE_HOMOLOGACION_URL, WsfeClient } from './wsfe.js';

let handle: DatabaseHandle;
beforeEach(() => {
  handle = openDatabase(':memory:');
});
afterEach(() => handle.close());

const REQUEST: VoucherRequest = {
  pointOfSale: 3,
  number: 1,
  issueDate: '2026-10-15',
  serviceFrom: '2026-10-01',
  serviceTo: '2026-10-31',
  paymentDueDate: '2026-10-31',
  receiverCuit: '30711111111',
  receiverIvaCondition: 6,
  totalCents: 20_160_000,
};

describe('ARCA simulado (modo mock)', () => {
  it('autoriza con números correlativos por punto de venta y un CAE de 14 dígitos que vence a los 10 días (RF-186, AC-196)', async () => {
    const arca = new MockArcaClient(handle.db);

    const first = await arca.authorize(REQUEST);
    const second = await arca.authorize({ ...REQUEST, number: 2, issueDate: '2026-10-28' });

    expect([first.number, second.number]).toEqual([1, 2]);
    expect(first.cae).toMatch(/^\d{14}$/);
    expect(second.cae).toMatch(/^\d{14}$/);
    expect(first.caeDueDate).toBe('2026-10-25');
    expect(second.caeDueDate).toBe('2026-11-07');
    expect(await arca.lastAuthorizedNumber(3)).toBe(2);
    expect(await arca.lastAuthorizedNumber(5)).toBe(0);
  });

  it('empieza en 1 en cada punto de venta', async () => {
    const arca = new MockArcaClient(handle.db);
    await arca.authorize(REQUEST);
    expect((await arca.authorize({ ...REQUEST, pointOfSale: 5 })).number).toBe(1);
  });

  it('rechaza un número que no es el siguiente, como ARCA', async () => {
    const arca = new MockArcaClient(handle.db);
    await expect(arca.authorize({ ...REQUEST, number: 2 })).rejects.toThrow(/próximo número a autorizar es 1/);
    await arca.authorize(REQUEST);
    await expect(arca.authorize(REQUEST)).rejects.toThrow(ArcaError);
  });

  it('consulta un comprobante autorizado (para RF-76)', async () => {
    const arca = new MockArcaClient(handle.db);
    const authorized = await arca.authorize(REQUEST);

    expect(await arca.getVoucher(3, 1)).toEqual(authorized);
    expect(await arca.getVoucher(3, 2)).toBeNull();
  });

  it('createArcaClient usa el simulado en modo mock, sin certificado ni conexión (RF-185)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const arca = createArcaClient(loadConfig({ MOCK_MODE: 'true' }), handle.db);

    expect(arca).toBeInstanceOf(MockArcaClient);
    await arca.authorize(REQUEST);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('addDays cruza meses y años', () => {
    expect(addDays('2026-12-28', 10)).toBe('2027-01-07');
    expect(addDays('2028-02-25', 5)).toBe('2028-03-01');
  });
});

describe('importes de ARCA', () => {
  it('convierte centavos a importe y de vuelta', () => {
    expect(toArcaAmount(1_500_050)).toBe('15000.50');
    expect(toArcaAmount(1)).toBe('0.01');
    expect(fromArcaAmount('15000.5')).toBe(1_500_050);
    expect(fromArcaAmount('201600')).toBe(20_160_000);
  });
});

// --- WSAA ---

/** Certificado autofirmado para los tests: nunca sale del proceso. */
function testCredentials() {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2026-01-01');
  cert.validity.notAfter = new Date('2028-01-01');
  const attrs = [{ name: 'commonName', value: 'aldebaran-test' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

const LOGIN_RESPONSE = (expiration: string) =>
  '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov"><loginCmsReturn>' +
  '&lt;?xml version="1.0" encoding="UTF-8" standalone="yes"?&gt;&lt;loginTicketResponse version="1.0"&gt;' +
  `&lt;header&gt;&lt;expirationTime&gt;${expiration}&lt;/expirationTime&gt;&lt;/header&gt;` +
  '&lt;credentials&gt;&lt;token&gt;TOKEN-123&lt;/token&gt;&lt;sign&gt;SIGN-456&lt;/sign&gt;&lt;/credentials&gt;' +
  '&lt;/loginTicketResponse&gt;</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>';

describe('WSAA', () => {
  let dir: string;
  let certPath: string;
  let keyPath: string;
  let creds: { certPem: string; keyPem: string };
  const now = () => new Date('2026-10-15T11:00:00-03:00');

  beforeAll(() => {
    creds = testCredentials();
    dir = mkdtempSync(path.join(tmpdir(), 'aldebaran-arca-'));
    certPath = path.join(dir, 'arca.crt');
    keyPath = path.join(dir, 'arca.key');
    writeFileSync(certPath, creds.certPem);
    writeFileSync(keyPath, creds.keyPem);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('arma el TRA con el servicio y una vigencia de 12 h', () => {
    const tra = buildTra('wsfe', now());
    expect(tra).toContain('<service>wsfe</service>');
    expect(tra).toContain('<generationTime>2026-10-15T13:50:00-00:00</generationTime>');
    expect(tra).toContain('<expirationTime>2026-10-16T02:00:00-00:00</expirationTime>');
  });

  it('firma el TRA como CMS con el certificado, conteniendo el TRA', () => {
    const tra = buildTra('wsfe', now());
    const cms = signTra(tra, creds.certPem, creds.keyPem);

    const msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.decode64(cms))) as forge.pkcs7.PkcsSignedData & {
      rawCapture: { content: forge.asn1.Asn1 };
    };
    expect(msg.certificates).toHaveLength(1);
    expect(forge.util.decodeUtf8(msg.rawCapture.content.value[0]!.value as string)).toBe(tra);
  });

  it('rechaza un certificado inválido con un mensaje claro', () => {
    expect(() => signTra('<x/>', 'no es un pem', creds.keyPem)).toThrow(/formato PEM/);
  });

  it('pide el ticket a WSAA de homologación, lo guarda y lo reutiliza mientras esté vigente', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(LOGIN_RESPONSE('2026-10-16T02:00:00.000-03:00')));
    const options = { db: handle.db, certPath, keyPath, now, fetchImpl: fetchMock };

    expect(await getAccessTicket('wsfe', options)).toEqual({ token: 'TOKEN-123', sign: 'SIGN-456' });
    expect(await getAccessTicket('wsfe', options)).toEqual({ token: 'TOKEN-123', sign: 'SIGN-456' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(WSAA_HOMOLOGACION_URL);
    expect(handle.db.select().from(arcaAccessTickets).all()).toMatchObject([{ service: 'wsfe', token: 'TOKEN-123' }]);
  });

  it('pide uno nuevo cuando el guardado está por vencer', async () => {
    handle.db.insert(arcaAccessTickets).values({
      service: 'wsfe', token: 'VIEJO', sign: 'VIEJO', expiresAt: new Date(now().getTime() + 60_000),
    }).run();
    const fetchMock = vi.fn().mockResolvedValue(new Response(LOGIN_RESPONSE('2026-10-16T02:00:00.000-03:00')));

    const ticket = await getAccessTicket('wsfe', { db: handle.db, certPath, keyPath, now, fetchImpl: fetchMock });

    expect(ticket.token).toBe('TOKEN-123');
    expect(handle.db.select().from(arcaAccessTickets).all()).toHaveLength(1);
  });

  it('explica el error de "ya posee un TA válido"', async () => {
    const fault =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault>' +
      '<faultcode>ns1:coe.alreadyAuthenticated</faultcode>' +
      '<faultstring>El CEE ya posee un TA valido para el acceso al WSN solicitado</faultstring>' +
      '</soapenv:Fault></soapenv:Body></soapenv:Envelope>';
    const fetchMock = vi.fn().mockResolvedValue(new Response(fault, { status: 500 }));

    await expect(
      getAccessTicket('wsfe', { db: handle.db, certPath, keyPath, now, fetchImpl: fetchMock }),
    ).rejects.toThrow(/ya hay uno vigente/);
  });

  it('informa si no puede leer el certificado (ARCA_CERT_PATH)', async () => {
    await expect(
      getAccessTicket('wsfe', { db: handle.db, certPath: '/no/existe.crt', keyPath, now }),
    ).rejects.toThrow(/No se pudo leer el certificado/);
  });
});

// --- WSFEv1 ---

const soap = (body: string) =>
  '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
  `<soap:Body>${body}</soap:Body></soap:Envelope>`;

const CAE_APPROVED = soap(
  '<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult>' +
    '<FeCabResp><Cuit>20111111112</Cuit><PtoVta>3</PtoVta><CbteTipo>11</CbteTipo><Resultado>A</Resultado></FeCabResp>' +
    '<FeDetResp><FECAEDetResponse><Concepto>2</Concepto><DocTipo>80</DocTipo><DocNro>30711111111</DocNro>' +
    '<CbteDesde>1</CbteDesde><CbteHasta>1</CbteHasta><CbteFch>20261015</CbteFch><Resultado>A</Resultado>' +
    '<CAE>76421234567890</CAE><CAEFchVto>20261025</CAEFchVto></FECAEDetResponse></FeDetResp>' +
    '</FECAESolicitarResult></FECAESolicitarResponse>',
);

const CAE_REJECTED = soap(
  '<FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult>' +
    '<FeCabResp><Resultado>R</Resultado></FeCabResp>' +
    '<FeDetResp><FECAEDetResponse><Resultado>R</Resultado><CAE></CAE><CAEFchVto></CAEFchVto>' +
    '<Observaciones><Obs><Code>10242</Code><Msg>El campo Condicion IVA receptor no es valido</Msg></Obs></Observaciones>' +
    '</FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse>',
);

const LAST_AUTHORIZED = soap(
  '<FECompUltimoAutorizadoResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompUltimoAutorizadoResult>' +
    '<PtoVta>3</PtoVta><CbteTipo>11</CbteTipo><CbteNro>41</CbteNro>' +
    '</FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse>',
);

const VOUCHER_FOUND = soap(
  '<FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet>' +
    '<Concepto>2</Concepto><DocTipo>80</DocTipo><DocNro>30711111111</DocNro><CbteDesde>42</CbteDesde>' +
    '<CbteHasta>42</CbteHasta><CbteFch>20261015</CbteFch><ImpTotal>201600</ImpTotal><Resultado>A</Resultado>' +
    '<CodAutorizacion>76421234567890</CodAutorizacion><EmisionTipo>CAE</EmisionTipo><FchVto>20261025</FchVto>' +
    '<PtoVta>3</PtoVta><CbteTipo>11</CbteTipo>' +
    '</ResultGet></FECompConsultarResult></FECompConsultarResponse>',
);

const VOUCHER_NOT_FOUND = soap(
  '<FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult>' +
    '<Errors><Err><Code>602</Code><Msg>No existen datos en nuestros registros para los parametros ingresados.</Msg></Err></Errors>' +
    '</FECompConsultarResult></FECompConsultarResponse>',
);

describe('WSFEv1', () => {
  function client(response: string | (() => Promise<Response>), status = 200) {
    const fetchMock = vi.fn(typeof response === 'string' ? async () => new Response(response, { status }) : response);
    const wsfe = new WsfeClient({
      cuit: '20111111112',
      getTicket: async () => ({ token: 'TOKEN-123', sign: 'SIGN-456' }),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const sent = () => ({
      url: fetchMock.mock.calls[0]![0] as unknown as string,
      init: fetchMock.mock.calls[0]![1] as unknown as RequestInit,
    });
    return { wsfe, sent };
  }

  it('pide el CAE de una Factura C de servicios con el punto de venta y la condición IVA del receptor (RF-71, RF-72, RF-77, AC-70)', async () => {
    const { wsfe, sent } = client(CAE_APPROVED);

    const voucher = await wsfe.authorize(REQUEST);

    expect(voucher).toEqual({
      pointOfSale: 3, number: 1, cae: '76421234567890', caeDueDate: '2026-10-25',
      issueDate: '2026-10-15', receiverCuit: '30711111111', totalCents: 20_160_000,
    });
    const { url, init } = sent();
    const body = init.body as string;
    expect(url).toBe(WSFE_HOMOLOGACION_URL);
    expect((init.headers as Record<string, string>).SOAPAction).toBe('http://ar.gov.afip.dif.FEV1/FECAESolicitar');
    for (const fragment of [
      '<ar:Token>TOKEN-123</ar:Token>', '<ar:Cuit>20111111112</ar:Cuit>',
      '<ar:PtoVta>3</ar:PtoVta>', '<ar:CbteTipo>11</ar:CbteTipo>', '<ar:Concepto>2</ar:Concepto>',
      '<ar:DocTipo>80</ar:DocTipo>', '<ar:DocNro>30711111111</ar:DocNro>',
      '<ar:CbteDesde>1</ar:CbteDesde>', '<ar:CbteFch>20261015</ar:CbteFch>',
      '<ar:ImpTotal>201600.00</ar:ImpTotal>', '<ar:ImpNeto>201600.00</ar:ImpNeto>', '<ar:ImpIVA>0</ar:ImpIVA>',
      '<ar:FchServDesde>20261001</ar:FchServDesde>', '<ar:FchServHasta>20261031</ar:FchServHasta>',
      '<ar:FchVtoPago>20261031</ar:FchVtoPago>', '<ar:MonId>PES</ar:MonId>',
      '<ar:CondicionIVAReceptorId>6</ar:CondicionIVAReceptorId>',
    ]) {
      expect(body).toContain(fragment);
    }
  });

  it('nunca usa los endpoints productivos', () => {
    expect(WSFE_HOMOLOGACION_URL).toContain('homo');
    expect(WSAA_HOMOLOGACION_URL).toContain('homo');
  });

  it('informa el motivo del rechazo', async () => {
    const { wsfe } = client(CAE_REJECTED);
    await expect(wsfe.authorize(REQUEST)).rejects.toThrow(
      'ARCA rechazó la factura 3-1: [10242] El campo Condicion IVA receptor no es valido',
    );
  });

  it('informa el faultstring de un SOAP Fault', async () => {
    const fault = soap('<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Servicio no disponible</faultstring></soap:Fault>');
    const { wsfe } = client(fault, 500);
    await expect(wsfe.authorize(REQUEST)).rejects.toThrow('ARCA devolvió un error: Servicio no disponible');
  });

  it('da la llamada por fallida a los 30 s (RNF-07, AC-228)', async () => {
    vi.useFakeTimers();
    try {
      // Un fetch que no responde nunca, salvo que se aborte su signal.
      const hanging = vi.fn((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))),
      );
      const slow = new WsfeClient({
        cuit: '20111111112',
        getTicket: async () => ({ token: 't', sign: 's' }),
        fetchImpl: hanging as unknown as typeof fetch,
      });
      const result = expect(slow.lastAuthorizedNumber(3)).rejects.toThrow('ARCA no respondió en 30 s');
      await vi.advanceTimersByTimeAsync(ARCA_TIMEOUT_MS);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it('lee el último número autorizado', async () => {
    const { wsfe, sent } = client(LAST_AUTHORIZED);
    expect(await wsfe.lastAuthorizedNumber(3)).toBe(41);
    expect(sent().init.body).toContain('<ar:FECompUltimoAutorizado>');
  });

  it('consulta un comprobante existente y devuelve null si no existe (RF-76)', async () => {
    expect(await client(VOUCHER_FOUND).wsfe.getVoucher(3, 42)).toEqual({
      pointOfSale: 3, number: 42, cae: '76421234567890', caeDueDate: '2026-10-25',
      issueDate: '2026-10-15', receiverCuit: '30711111111', totalCents: 20_160_000,
    });
    expect(await client(VOUCHER_NOT_FOUND).wsfe.getVoucher(3, 43)).toBeNull();
  });
});
