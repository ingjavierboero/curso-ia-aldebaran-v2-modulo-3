import { FilePdfOutlined } from '@ant-design/icons';
import { App, DatePicker, Select, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';
import { listClients, type Client } from '../../api/clients';
import {
  formatVoucherNumber,
  INVOICE_STATUS_COLORS,
  INVOICE_STATUS_LABELS,
  invoicePdfUrl,
  listInvoices,
  type InvoiceRow,
  type InvoiceStatus,
} from '../../api/invoices';
import { formatMoney } from '../../domain/money';
import { BillingCard } from './BillingCard';

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
`;

const STATUS_OPTIONS = Object.entries(INVOICE_STATUS_LABELS).map(([value, label]) => ({ value, label }));
const formatDate = (date: string) => dayjs(date).format('DD/MM/YYYY');
const formatPeriod = (period: string) => dayjs(`${period}-01`).format('MMMM YYYY');

/** RF-160, RF-162, RF-168: listado de facturas con filtros y descarga del PDF. */
export function InvoicesPage() {
  const { message } = App.useApp();
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<InvoiceStatus>();
  const [clientId, setClientId] = useState<number>();
  const [period, setPeriod] = useState<Dayjs | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInvoices(await listInvoices({ status, clientId, period: period?.format('YYYY-MM') }));
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudieron cargar las facturas.');
    } finally {
      setLoading(false);
    }
  }, [status, clientId, period, message]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    listClients({}).then(setClients).catch(() => setClients([]));
  }, []);

  const columns: ColumnsType<InvoiceRow> = [
    {
      title: 'Número',
      key: 'number',
      render: (_, i) => <Typography.Text style={{ whiteSpace: 'nowrap' }}>C {formatVoucherNumber(i.pointOfSale, i.number)}</Typography.Text>,
    },
    { title: 'Cliente', dataIndex: 'clientBusinessName' },
    { title: 'Período', dataIndex: 'period', render: (p: string) => <span style={{ textTransform: 'capitalize' }}>{formatPeriod(p)}</span> },
    { title: 'Total', dataIndex: 'totalCents', align: 'right', render: (cents: number) => formatMoney(cents, 'ARS') },
    { title: 'Vencimiento', dataIndex: 'paymentDueDate', render: formatDate },
    {
      title: 'Estado',
      dataIndex: 'status',
      render: (value: InvoiceStatus, i) => (
        <Tooltip title={i.reviewReason ? `Motivo: ${i.reviewReason}` : undefined}>
          <Tag color={INVOICE_STATUS_COLORS[value]}>{INVOICE_STATUS_LABELS[value]}</Tag>
        </Tooltip>
      ),
    },
    {
      title: 'PDF',
      key: 'pdf',
      align: 'center',
      width: 70,
      render: (_, i) => (
        <Tooltip title="Descargar PDF">
          <a href={invoicePdfUrl(i.id)} target="_blank" rel="noreferrer" aria-label="Descargar PDF">
            <FilePdfOutlined />
          </a>
        </Tooltip>
      ),
    },
  ];

  const filtered = status || clientId || period;

  return (
    <>
      <Typography.Title level={3}>Facturas</Typography.Title>
      <BillingCard onFinished={load} />
      <Toolbar>
        <Select
          allowClear
          placeholder="Estado"
          options={STATUS_OPTIONS}
          value={status}
          onChange={setStatus}
          style={{ minWidth: 180 }}
          aria-label="Filtrar por estado"
        />
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
        <DatePicker
          picker="month"
          placeholder="Período"
          format="MMMM YYYY"
          value={period}
          onChange={setPeriod}
          aria-label="Filtrar por período"
        />
      </Toolbar>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={invoices}
        loading={loading}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{ emptyText: filtered ? 'Ninguna factura coincide con los filtros.' : 'Todavía no hay facturas.' }}
        scroll={{ x: true }}
      />
    </>
  );
}
