import { ArrowLeftOutlined, CheckCircleOutlined, FilePdfOutlined, RollbackOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Descriptions, Empty, Popconfirm, Result, Space, Spin, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import styled from 'styled-components';
import { IVA_CONDITIONS } from '../../api/clients';
import { ApiError } from '../../api/client';
import {
  formatVoucherNumber,
  getInvoice,
  INVOICE_STATUS_COLORS,
  INVOICE_STATUS_LABELS,
  invoicePdfUrl,
  markInvoicePaid,
  returnInvoiceToPending,
  type InvoiceDetail,
  type InvoiceItem,
} from '../../api/invoices';
import { EmailCard, Emails } from '../../components/EmailCard';
import { HistoryTimeline } from '../../components/HistoryTimeline';
import { formatCuit } from '../../domain/cuit';
import { formatMoney } from '../../domain/money';
import { useCanEdit } from '../../stores/session';

const Header = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;

  h3 {
    margin: 0;
  }
`;

const Actions = styled(Space)`
  margin-inline-start: auto;
`;

const Section = styled.div`
  margin-top: 16px;
`;

const formatDate = (date: string) => dayjs(date).format('DD/MM/YYYY');

/** RF-217: detalle de una factura con sus ítems, su historial de estados y los comprobantes recibidos. */
export function InvoiceDetailPage() {
  const { id } = useParams();
  const canEdit = useCanEdit();
  const { message } = App.useApp();
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await getInvoice(Number(id)));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'La factura no existe.'
          : err instanceof Error
            ? err.message
            : 'No se pudo cargar la factura.',
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = (
    <Link to="/facturas">
      <ArrowLeftOutlined /> Volver a facturas
    </Link>
  );

  if (error) return <Result status="warning" title={error} extra={back} />;
  if (!detail) return <Spin style={{ display: 'block', marginTop: 64 }} />;

  const { invoice, items, history, emails } = detail;
  const voucher = `C ${formatVoucherNumber(invoice.pointOfSale, invoice.number)}`;

  async function run(action: () => Promise<void>, done: string) {
    try {
      await action();
      message.success(done);
      await load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'No se pudo cambiar el estado.');
    }
  }

  const inReview = invoice.status === 'pago_recibido' || invoice.status === 'revision_manual';
  const columns = [
    { title: 'Descripción', dataIndex: 'description' },
    {
      title: 'Precio',
      key: 'price',
      align: 'right' as const,
      render: (_: unknown, item: InvoiceItem) => formatMoney(item.unitPriceCents, item.currency),
    },
    {
      title: 'Importe',
      dataIndex: 'amountCents',
      align: 'right' as const,
      render: (cents: number) => formatMoney(cents, 'ARS'),
    },
  ];

  return (
    <>
      <div style={{ marginBottom: 12 }}>{back}</div>
      <Header>
        <Typography.Title level={3}>Factura {voucher}</Typography.Title>
        <Tag color={INVOICE_STATUS_COLORS[invoice.status]}>{INVOICE_STATUS_LABELS[invoice.status]}</Tag>
        <Actions wrap>
          <Button icon={<FilePdfOutlined />} href={invoicePdfUrl(invoice.id)} target="_blank">
            Descargar PDF
          </Button>
          {canEdit && invoice.status !== 'pagada' && (
            <Popconfirm title={`¿Marcar la factura ${voucher} como Pagada?`} okText="Sí" cancelText="No" onConfirm={() => run(() => markInvoicePaid(invoice.id), `Factura ${voucher} Pagada.`)}>
              <Button type="primary" icon={<CheckCircleOutlined />}>
                Marcar como Pagada
              </Button>
            </Popconfirm>
          )}
          {canEdit && inReview && (
            <Popconfirm
              title={`¿Devolver la factura ${voucher} a Pendiente de pago?`}
              okText="Sí"
              cancelText="No"
              onConfirm={() => run(() => returnInvoiceToPending(invoice.id), `Factura ${voucher} devuelta a Pendiente de pago.`)}
            >
              <Button icon={<RollbackOutlined />}>Devolver a Pendiente</Button>
            </Popconfirm>
          )}
        </Actions>
      </Header>

      {invoice.reviewReason && <Alert type="warning" showIcon title={`Motivo de la revisión: ${invoice.reviewReason}`} style={{ marginBottom: 16 }} />}

      <Card title="Datos de la factura">
        <Descriptions column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="Cliente">
            <Link to={`/clientes/${invoice.clientId}`}>{invoice.clientBusinessName}</Link>
          </Descriptions.Item>
          <Descriptions.Item label="CUIT">{formatCuit(invoice.clientCuit)}</Descriptions.Item>
          <Descriptions.Item label="Domicilio">{invoice.clientAddress ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Condición frente al IVA">{IVA_CONDITIONS[invoice.clientIvaCondition]}</Descriptions.Item>
          <Descriptions.Item label="Período">
            <span style={{ textTransform: 'capitalize' }}>{dayjs(`${invoice.period}-01`).format('MMMM YYYY')}</span>
          </Descriptions.Item>
          <Descriptions.Item label="Servicio">
            {formatDate(invoice.serviceFrom)} al {formatDate(invoice.serviceTo)}
          </Descriptions.Item>
          <Descriptions.Item label="Fecha de emisión">{formatDate(invoice.issueDate)}</Descriptions.Item>
          <Descriptions.Item label="Vencimiento del pago">{formatDate(invoice.paymentDueDate)}</Descriptions.Item>
          <Descriptions.Item label="CAE">{invoice.cae}</Descriptions.Item>
          <Descriptions.Item label="Vencimiento del CAE">{formatDate(invoice.caeDueDate)}</Descriptions.Item>
          {invoice.exchangeRateCents !== null && (
            <Descriptions.Item label="Cotización del dólar">
              {formatMoney(invoice.exchangeRateCents, 'ARS')}
              {invoice.exchangeRateFallback && ' (última registrada)'}
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Total">
            <Typography.Text strong>{formatMoney(invoice.totalCents, 'ARS')}</Typography.Text>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Section>
        <Card title="Ítems">
          <Table rowKey="id" columns={columns} dataSource={items} pagination={false} size="small" />
        </Card>
      </Section>

      <Section>
        <Card title="Historial de estados">
          <HistoryTimeline events={history} />
        </Card>
      </Section>

      <Section>
        <Card title="Comprobantes recibidos">
          {emails.length === 0 ? (
            <Empty description="Todavía no se recibió ningún comprobante para esta factura." />
          ) : (
            <Emails>
              {emails.map((email) => (
                <EmailCard key={email.id} email={email} />
              ))}
            </Emails>
          )}
        </Card>
      </Section>
    </>
  );
}
