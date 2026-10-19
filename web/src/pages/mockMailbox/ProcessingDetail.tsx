import { Descriptions, Table, Tag, Tooltip, Typography } from 'antd';
import type { EmailProcessing } from '../../api/mockMailbox';
import { formatVoucherNumber, INVOICE_STATUS_LABELS, type InvoiceStatus } from '../../api/invoices';

const CLASSIFICATION_LABELS: Record<NonNullable<EmailProcessing['classification']>, string> = {
  si: 'Comprobante ("si")',
  no: 'No es un comprobante ("no")',
  dudoso: 'Dudoso',
  erroneo: 'Procesamiento erróneo',
};

/** Columna "Procesamiento": estado y resultado de un email recibido. */
export function ProcessingTag({ processing }: { processing: EmailProcessing | null }) {
  if (!processing) return null;
  if (processing.status === 'pendiente') {
    return (
      <Tooltip title="Se procesa en la próxima revisión de la casilla.">
        <Tag>Pendiente</Tag>
      </Tooltip>
    );
  }
  if (processing.status === 'aviso') {
    return (
      <Tooltip title="El remitente no es el email de facturación de ningún cliente.">
        <Tag color="orange">Aviso</Tag>
      </Tooltip>
    );
  }
  const reason = processing.changes.find((c) => c.reason)?.reason;
  switch (processing.validationResult) {
    case 'pago_recibido':
      return <Tag color="blue">Pago recibido</Tag>;
    case 'revision_manual':
      return (
        <Tooltip title={reason ? `Motivo: ${reason}` : undefined}>
          <Tag color="volcano">Revisión manual</Tag>
        </Tooltip>
      );
    case 'sin_cambios':
      return <Tag>Sin cambios</Tag>;
    default:
      // Sin resultado de validación: no tenía adjuntos válidos, o se procesó antes de que
      // existiera la validación (solo se clasificó).
      return processing.classification ? (
        <Tag>Clasificado: {processing.classification}</Tag>
      ) : (
        <Tooltip title="No traía adjuntos de imagen o PDF: no se clasifica.">
          <Tag>Sin adjuntos válidos</Tag>
        </Tooltip>
      );
  }
}

/** Detalle del procesamiento, al desplegar un email recibido. */
export function ProcessingDetail({ processing }: { processing: EmailProcessing }) {
  if (processing.status === 'pendiente') {
    return <Typography.Text type="secondary">Todavía no se procesó: se procesa en la próxima revisión de la casilla.</Typography.Text>;
  }
  if (processing.status === 'aviso') {
    return <Typography.Text type="secondary">Quedó como aviso: el remitente no es el email de facturación de ningún cliente.</Typography.Text>;
  }

  const result =
    processing.validationResult === 'pago_recibido'
      ? 'Facturas a Pago recibido'
      : processing.validationResult === 'revision_manual'
        ? 'Facturas a Revisión manual'
        : processing.validationResult === 'sin_cambios'
          ? 'Ninguna factura cambió'
          : processing.classification
            ? 'Solo se clasificó (sin validación)'
            : 'Sin adjuntos válidos: no se clasificó';

  return (
    <>
      <Descriptions size="small" column={1} style={{ marginBottom: 8 }}>
        <Descriptions.Item label="Cliente">{processing.clientName}</Descriptions.Item>
        <Descriptions.Item label="Clasificación">
          {processing.classification ? CLASSIFICATION_LABELS[processing.classification] : '—'}
        </Descriptions.Item>
        <Descriptions.Item label="Resultado">
          {result}
          {processing.validationRule && (
            <>
              {' '}
              <Typography.Text type="secondary">({processing.validationRule})</Typography.Text>
            </>
          )}
        </Descriptions.Item>
      </Descriptions>
      {processing.changes.length > 0 && (
        <ul style={{ margin: '0 0 8px', paddingInlineStart: 20 }}>
          {processing.changes.map((c) => (
            <li key={c.invoiceId}>
              Factura C {formatVoucherNumber(c.pointOfSale, c.number)} → {INVOICE_STATUS_LABELS[c.to as InvoiceStatus] ?? c.to}
              {c.reason && <Typography.Text type="secondary"> · motivo: {c.reason}</Typography.Text>}
            </li>
          ))}
        </ul>
      )}
      {processing.attachments.length > 0 && (
        <Table
          size="small"
          pagination={false}
          rowKey={(a) => a.filename}
          dataSource={processing.attachments}
          columns={[
            { title: 'Adjunto', dataIndex: 'filename' },
            {
              title: 'Clasificación',
              key: 'classification',
              render: (_, a) =>
                !a.valid ? (
                  <Typography.Text type="secondary">no se procesa</Typography.Text>
                ) : a.error ? (
                  <Tooltip title={a.error}>
                    <Tag color="red">Erróneo</Tag>
                  </Tooltip>
                ) : (
                  <Tag>{a.classification}</Tag>
                ),
            },
            { title: 'CUIT extraído', dataIndex: 'cuit', render: (v: string | null, a) => (a.classification === 'si' ? (v ?? 'no extraído') : '') },
            { title: 'Monto extraído', dataIndex: 'amount', render: (v: string | null, a) => (a.classification === 'si' ? (v ?? 'no extraído') : '') },
          ]}
        />
      )}
    </>
  );
}
