import { PaperClipOutlined } from '@ant-design/icons';
import { App, Badge, Card, Empty, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';
import { formatVoucherNumber, INVOICE_STATUS_COLORS, INVOICE_STATUS_LABELS } from '../../api/invoices';
import {
  listNotices,
  listProcessErrors,
  listReviewInvoices,
  OPERATION_LABELS,
  receivedAttachmentUrl,
  type ProcessErrorRow,
  type ReceivedEmail,
  type ReviewInvoice,
} from '../../api/review';
import { AttachmentResults } from '../../components/AttachmentResults';
import { formatMoney } from '../../domain/money';

const Body = styled.pre`
  white-space: pre-wrap;
  font-family: inherit;
  margin: 0 0 8px;
`;

const Emails = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const dateTime = (iso: string) => dayjs(iso).format('DD/MM/YYYY HH:mm');
const periodName = (period: string) => dayjs(`${period}-01`).format('MMMM YYYY');

const EMAIL_CLASS: Record<NonNullable<ReceivedEmail['classification']>, { label: string; color: string }> = {
  si: { label: 'Comprobante', color: 'green' },
  no: { label: 'No es comprobante', color: 'default' },
  dudoso: { label: 'Dudoso', color: 'gold' },
  erroneo: { label: 'Procesamiento erróneo', color: 'red' },
};

/** Un email recibido con su cuerpo y el resultado de cada adjunto. */
function EmailCard({ email }: { email: ReceivedEmail }) {
  const cls = email.classification ? EMAIL_CLASS[email.classification] : null;
  return (
    <Card
      size="small"
      title={
        <Space wrap size={4}>
          <span>{email.subject || '(sin asunto)'}</span>
          <Typography.Text type="secondary" style={{ fontWeight: 'normal' }}>
            · {email.from} · {dateTime(email.receivedAt)}
          </Typography.Text>
        </Space>
      }
      extra={cls && <Tag color={cls.color}>{cls.label}</Tag>}
    >
      <Body>{email.text.trim() || '(sin cuerpo)'}</Body>
      {email.attachments.length > 0 && (
        <AttachmentResults
          attachments={email.attachments.map((a) => ({ ...a, href: receivedAttachmentUrl(email.id, a.id) }))}
        />
      )}
    </Card>
  );
}

/** RF-141: facturas en Pago recibido o Revisión manual con sus comprobantes. */
function PaymentsTab({ invoices, loading }: { invoices: ReviewInvoice[]; loading: boolean }) {
  const columns: ColumnsType<ReviewInvoice> = [
    { title: 'Factura', key: 'number', render: (_, i) => <span style={{ whiteSpace: 'nowrap' }}>C {formatVoucherNumber(i.pointOfSale, i.number)}</span> },
    { title: 'Cliente', dataIndex: 'clientName' },
    { title: 'Período', dataIndex: 'period', render: (p: string) => <span style={{ textTransform: 'capitalize' }}>{periodName(p)}</span> },
    { title: 'Total', dataIndex: 'totalCents', align: 'right', render: (c: number) => formatMoney(c, 'ARS') },
    { title: 'Vencimiento', dataIndex: 'paymentDueDate', render: (d: string) => dayjs(d).format('DD/MM/YYYY') },
    { title: 'Estado', dataIndex: 'status', render: (s: ReviewInvoice['status']) => <Tag color={INVOICE_STATUS_COLORS[s]}>{INVOICE_STATUS_LABELS[s]}</Tag> },
    {
      title: 'Motivo',
      dataIndex: 'reviewReason',
      render: (reason: string | null) => (reason ? <Typography.Text type="danger">{reason}</Typography.Text> : null),
    },
    {
      title: <PaperClipOutlined aria-label="Emails" />,
      key: 'emails',
      align: 'center',
      render: (_, i) => i.emails.length || '',
    },
  ];

  return (
    <Table
      rowKey="id"
      columns={columns}
      dataSource={invoices}
      loading={loading}
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
      scroll={{ x: true }}
      locale={{ emptyText: <Empty description="No hay pagos para revisar." /> }}
      expandable={{
        expandRowByClick: true,
        expandedRowRender: (invoice) =>
          invoice.emails.length === 0 ? (
            <Typography.Text type="secondary">Sin emails asociados.</Typography.Text>
          ) : (
            <Emails>
              {invoice.emails.map((email) => (
                <EmailCard key={email.id} email={email} />
              ))}
            </Emails>
          ),
      }}
    />
  );
}

/** RF-142: avisos Pendientes (emails de remitentes que no son clientes). */
function NoticesTab({ notices, loading }: { notices: ReceivedEmail[]; loading: boolean }) {
  return (
    <Table
      rowKey="id"
      dataSource={notices}
      loading={loading}
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
      scroll={{ x: true }}
      locale={{ emptyText: <Empty description="No hay avisos pendientes." /> }}
      columns={[
        { title: 'Fecha', dataIndex: 'receivedAt', width: 150, render: dateTime },
        { title: 'Remitente', key: 'from', render: (_, n) => (n.fromName ? `${n.fromName} <${n.from}>` : n.from) },
        { title: 'Asunto', dataIndex: 'subject' },
        {
          title: 'Adjuntos',
          key: 'attachments',
          render: (_, n) => (
            <Space wrap size={[12, 0]}>
              {n.attachments.map((a) => (
                <a key={a.id} href={receivedAttachmentUrl(n.id, a.id)} target="_blank" rel="noreferrer">
                  <PaperClipOutlined /> {a.filename}
                </a>
              ))}
            </Space>
          ),
        },
      ]}
      expandable={{
        expandRowByClick: true,
        expandedRowRender: (n) => <Body>{n.text.trim() || '(sin cuerpo)'}</Body>,
      }}
    />
  );
}

/** RF-175: errores de proceso Pendientes. */
function ErrorsTab({ errors, loading }: { errors: ProcessErrorRow[]; loading: boolean }) {
  return (
    <Table
      rowKey="id"
      dataSource={errors}
      loading={loading}
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
      scroll={{ x: true }}
      locale={{ emptyText: <Empty description="No hay errores de proceso pendientes." /> }}
      columns={[
        { title: 'Fecha', dataIndex: 'createdAt', width: 150, render: dateTime },
        { title: 'Operación', dataIndex: 'operation', render: (o: ProcessErrorRow['operation']) => OPERATION_LABELS[o] },
        { title: 'Cliente', dataIndex: 'clientName', render: (c: string | null) => c ?? '—' },
        {
          title: 'Período / factura',
          key: 'period',
          render: (_, e) =>
            e.invoiceNumber !== null
              ? `C ${formatVoucherNumber(e.invoicePointOfSale!, e.invoiceNumber)}`
              : e.period
                ? <span style={{ textTransform: 'capitalize' }}>{periodName(e.period)}</span>
                : '—',
        },
        { title: 'Intentos', dataIndex: 'attempts', align: 'center' },
        {
          title: 'Último error',
          dataIndex: 'lastError',
          render: (msg: string) => (
            <Tooltip title={msg}>
              <Typography.Text type="danger" ellipsis style={{ maxWidth: 360 }}>
                {msg}
              </Typography.Text>
            </Tooltip>
          ),
        },
      ]}
    />
  );
}

/** Interfaz de revisión: pagos informados, avisos y errores de proceso (RF-141, RF-142, RF-175). */
export function ReviewPage() {
  const { message } = App.useApp();
  const [invoices, setInvoices] = useState<ReviewInvoice[]>([]);
  const [notices, setNotices] = useState<ReceivedEmail[]>([]);
  const [errors, setErrors] = useState<ProcessErrorRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [i, n, e] = await Promise.all([listReviewInvoices(), listNotices(), listProcessErrors()]);
      setInvoices(i);
      setNotices(n);
      setErrors(e);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudo cargar la revisión.');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const label = (text: string, count: number, color?: string) => (
    <Space size={6}>
      {text}
      <Badge count={count} showZero color={count === 0 ? '#bfbfbf' : color} />
    </Space>
  );

  return (
    <>
      <Typography.Title level={3}>Revisión</Typography.Title>
      <Tabs
        items={[
          { key: 'payments', label: label('Pagos informados', invoices.length, '#1677ff'), children: <PaymentsTab invoices={invoices} loading={loading} /> },
          { key: 'notices', label: label('Avisos', notices.length, '#fa8c16'), children: <NoticesTab notices={notices} loading={loading} /> },
          { key: 'errors', label: label('Errores de proceso', errors.length, '#ff4d4f'), children: <ErrorsTab errors={errors} loading={loading} /> },
        ]}
      />
    </>
  );
}
