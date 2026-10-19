import { CheckCircleOutlined, CheckOutlined, PaperClipOutlined, RedoOutlined, RollbackOutlined } from '@ant-design/icons';
import { App, Badge, Card, DatePicker, Empty, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { listClients, type Client } from '../../api/clients';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import styled from 'styled-components';
import { formatVoucherNumber, INVOICE_STATUS_COLORS, INVOICE_STATUS_LABELS, markInvoicePaid, returnInvoiceToPending } from '../../api/invoices';
import {
  listNotices,
  listProcessErrors,
  listResolved,
  listReviewInvoices,
  markNoticeReviewed,
  OPERATION_LABELS,
  receivedAttachmentUrl,
  resolveProcessError,
  RETRYABLE_OPERATIONS,
  retryProcessError,
  type ProcessErrorRow,
  type ReceivedEmail,
  type ResolvedPayment,
  type ReviewInvoice,
} from '../../api/review';
import { Body, EmailCard, Emails } from '../../components/EmailCard';
import { TableAction } from '../../components/TableAction';
import { useCanEdit } from '../../stores/session';
import { formatMoney } from '../../domain/money';

const dateTime = (iso: string) => dayjs(iso).format('DD/MM/YYYY HH:mm');
const periodName = (period: string) => dayjs(`${period}-01`).format('MMMM YYYY');

/** Ejecuta una acción, avisa el resultado y recarga la revisión. */
type Run = (action: () => Promise<unknown>, success: string) => Promise<void>;

const actionsColumn = <T,>(render: (row: T) => ReactNode): ColumnsType<T>[number] => ({
  title: 'Acciones',
  key: 'actions',
  align: 'center',
  width: 110,
  render: (_, row) => render(row),
});

/** RF-141: facturas en Pago recibido o Revisión manual con sus comprobantes. */
function PaymentsTab({ invoices, loading, run }: { invoices: ReviewInvoice[]; loading: boolean; run?: Run }) {
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
  // RF-143 a RF-146: solo Admin y Editor.
  if (run) {
    columns.push(
      actionsColumn<ReviewInvoice>((i) => {
        const number = `C ${formatVoucherNumber(i.pointOfSale, i.number)}`;
        return (
          <Space size={4}>
            <TableAction
              label="Pago confirmado: pasar a Pagada"
              icon={<CheckCircleOutlined />}
              confirm={`¿Confirmás el pago de la factura ${number}? Pasa a Pagada.`}
              onClick={() => run(() => markInvoicePaid(i.id), `Factura ${number} Pagada.`)}
            />
            <TableAction
              label="Pago no realizado: devolver a Pendiente de pago"
              icon={<RollbackOutlined />}
              danger
              confirm={`¿El pago no se realizó? La factura ${number} vuelve a Pendiente de pago.`}
              onClick={() => run(() => returnInvoiceToPending(i.id), `Factura ${number} devuelta a Pendiente de pago.`)}
            />
          </Space>
        );
      }),
    );
  }

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
function NoticesTab({ notices, loading, run }: { notices: ReceivedEmail[]; loading: boolean; run?: Run }) {
  const columns: ColumnsType<ReceivedEmail> = [
    { title: 'Fecha', dataIndex: 'receivedAt', width: 150, render: dateTime },
    { title: 'Remitente', key: 'from', render: (_, n) => (n.fromName ? `${n.fromName} <${n.from}>` : n.from) },
    { title: 'Asunto', dataIndex: 'subject' },
    {
      title: 'Adjuntos',
      key: 'attachments',
      render: (_, n) => (
        <Space wrap size={[12, 0]}>
          {n.attachments.map((a) => (
            <a key={a.id} href={receivedAttachmentUrl(n.id, a.id)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              <PaperClipOutlined /> {a.filename}
            </a>
          ))}
        </Space>
      ),
    },
  ];
  // RF-148
  if (run) {
    columns.push(
      actionsColumn<ReceivedEmail>((n) => (
        <TableAction
          label="Marcar como revisado"
          icon={<CheckOutlined />}
          onClick={() => run(() => markNoticeReviewed(n.id), 'Aviso marcado como revisado.')}
        />
      )),
    );
  }
  return (
    <Table
      rowKey="id"
      dataSource={notices}
      columns={columns}
      loading={loading}
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
      scroll={{ x: true }}
      locale={{ emptyText: <Empty description="No hay avisos pendientes." /> }}
      expandable={{
        expandRowByClick: true,
        expandedRowRender: (n) => <Body>{n.text.trim() || '(sin cuerpo)'}</Body>,
      }}
    />
  );
}

/** RF-175: errores de proceso Pendientes. */
function ErrorsTab({ errors, loading, run }: { errors: ProcessErrorRow[]; loading: boolean; run?: Run }) {
  const actions = run
    ? [
        actionsColumn<ProcessErrorRow>((e) => (
          <Space size={4}>
            {RETRYABLE_OPERATIONS.includes(e.operation) && (
              <TableAction
                label="Reintentar (un intento)"
                icon={<RedoOutlined />}
                confirm={e.operation === 'generacion_factura' ? '¿Reintentar la generación? Si sale, la factura se envía por email.' : '¿Reenviar el email de la factura?'}
                onClick={() => run(() => retryProcessError(e.id), '')}
              />
            )}
            <TableAction
              label="Marcar como resuelto"
              icon={<CheckOutlined />}
              confirm="¿Marcar el error como resuelto sin reintentarlo?"
              onClick={() => run(() => resolveProcessError(e.id), 'Error marcado como resuelto.')}
            />
          </Space>
        )),
      ]
    : [];
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
        ...actions,
      ]}
    />
  );
}

const DECISIONS: Record<ResolvedPayment['decision'], { label: string; color: string }> = {
  pagada: { label: 'Pagada', color: 'green' },
  pendiente_pago: { label: 'Devuelta a Pendiente de pago', color: 'gold' },
};

/** RF-216: decisiones de los usuarios sobre los pagos informados, con sus comprobantes. */
function ResolvedTab() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<ResolvedPayment[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [clientId, setClientId] = useState<number>();
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listResolved({ clientId, from: range?.[0]?.format('YYYY-MM-DD'), to: range?.[1]?.format('YYYY-MM-DD') }));
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudieron cargar los resueltos.');
    } finally {
      setLoading(false);
    }
  }, [clientId, range, message]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    listClients({}).then(setClients).catch(() => setClients([]));
  }, []);

  const columns: ColumnsType<ResolvedPayment> = [
    { title: 'Decisión', dataIndex: 'decidedAt', width: 150, render: dateTime },
    {
      title: 'Factura',
      key: 'invoice',
      render: (_, r) => (r.invoice ? <span style={{ whiteSpace: 'nowrap' }}>C {formatVoucherNumber(r.invoice.pointOfSale, r.invoice.number)}</span> : '—'),
    },
    { title: 'Cliente', dataIndex: 'clientName' },
    { title: 'Período', key: 'period', render: (_, r) => (r.invoice ? <span style={{ textTransform: 'capitalize' }}>{periodName(r.invoice.period)}</span> : '—') },
    { title: 'Total', key: 'total', align: 'right', render: (_, r) => (r.invoice ? formatMoney(r.invoice.totalCents, 'ARS') : '—') },
    {
      title: 'Resultado',
      dataIndex: 'decision',
      render: (d: ResolvedPayment['decision']) => <Tag color={DECISIONS[d].color}>{DECISIONS[d].label}</Tag>,
    },
    {
      title: 'Estaba en',
      key: 'previous',
      render: (_, r) => (
        <Space orientation="vertical" size={0}>
          <span>{INVOICE_STATUS_LABELS[r.previousStatus]}</span>
          {r.previousReason && <Typography.Text type="secondary">{r.previousReason}</Typography.Text>}
        </Space>
      ),
    },
    { title: 'Usuario', dataIndex: 'userName', render: (n: string | null) => n ?? '—' },
  ];

  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          allowClear
          showSearch={{ optionFilterProp: 'label' }}
          placeholder="Cliente"
          options={clients.map((c) => ({ value: c.id, label: c.businessName }))}
          value={clientId}
          onChange={setClientId}
          style={{ minWidth: 220 }}
          aria-label="Filtrar por cliente"
        />
        <DatePicker.RangePicker
          format="DD/MM/YYYY"
          value={range}
          onChange={(value) => setRange(value)}
          placeholder={['Desde', 'Hasta']}
          aria-label="Filtrar por fecha de la decisión"
        />
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        scroll={{ x: true }}
        locale={{ emptyText: <Empty description={clientId || range ? 'Ningún pago resuelto coincide con los filtros.' : 'Todavía no hay pagos resueltos.'} /> }}
        expandable={{
          expandRowByClick: true,
          expandedRowRender: (r) =>
            r.emails.length === 0 ? (
              <Typography.Text type="secondary">Sin emails asociados.</Typography.Text>
            ) : (
              <Emails>
                {r.emails.map((email) => (
                  <EmailCard key={email.id} email={email} />
                ))}
              </Emails>
            ),
        }}
      />
    </>
  );
}

/** Interfaz de revisión: pagos informados, avisos, errores de proceso y resueltos (RF-141, RF-142, RF-175, RF-216). */
export function ReviewPage() {
  const { message } = App.useApp();
  const [invoices, setInvoices] = useState<ReviewInvoice[]>([]);
  const [notices, setNotices] = useState<ReceivedEmail[]>([]);
  const [errors, setErrors] = useState<ProcessErrorRow[]>([]);
  const [loading, setLoading] = useState(true);
  // La solapa abierta viaja en ?tab= para enlazarla (por ejemplo, desde el banner de errores).
  const [searchParams, setSearchParams] = useSearchParams();

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

  const canEdit = useCanEdit();
  /** RF-182: si la acción falla, el usuario ve el mensaje de error. */
  const run: Run = async (action, success) => {
    try {
      const result = await action();
      message.success(typeof result === 'string' && result ? result : success);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudo completar la acción.');
    } finally {
      void load();
    }
  };
  const actions = canEdit ? run : undefined;

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
        activeKey={searchParams.get('tab') ?? 'payments'}
        onChange={(tab) => setSearchParams({ tab }, { replace: true })}
        items={[
          { key: 'payments', label: label('Pagos informados', invoices.length, '#1677ff'), children: <PaymentsTab invoices={invoices} loading={loading} run={actions} /> },
          { key: 'notices', label: label('Avisos', notices.length, '#fa8c16'), children: <NoticesTab notices={notices} loading={loading} run={actions} /> },
          { key: 'errors', label: label('Errores de proceso', errors.length, '#ff4d4f'), children: <ErrorsTab errors={errors} loading={loading} run={actions} /> },
          // Se monta al abrir la solapa, así trae las decisiones recién tomadas.
          { key: 'resolved', label: 'Resueltos', children: <ResolvedTab />, destroyOnHidden: true },
        ]}
      />
    </>
  );
}
